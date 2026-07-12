// WhatsApp MCP — HTTP daemon (shared backend, many Claude Code clients)
// ----------------------------------------------------------------------
// ONE persistent process holds the single WhatsApp login + single Chromium.
// Every Claude Code session connects to it over HTTP as a client, so there is
// no per-session node copy fighting over the session-folder lock.
//
// Run ONCE (survives across CC sessions):   node server-http.js
// Then add to your Claude Code config:       { "type": "http", "url": "http://127.0.0.1:8765/mcp" }

const http = require('http');
const path = require('path');
const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrimage = require('qrcode');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const PORT = process.env.WA_MCP_PORT ? Number(process.env.WA_MCP_PORT) : 8765;
const SESSION_DIR = path.join(__dirname, 'session');
const DOWNLOAD_DIR = process.env.WA_DOWNLOAD_DIR || path.join(__dirname, 'wa-downloads');

// Your phone number is required to generate the pairing code.
// Set WA_PAIR_NUMBER env var (e.g. export WA_PAIR_NUMBER=601XXXXXXXX)
const PAIR_NUMBER = process.env.WA_PAIR_NUMBER;
if (!PAIR_NUMBER) {
  console.error('❌  WA_PAIR_NUMBER env var is required.');
  console.error('    Set it to your WhatsApp number in international format (no +), e.g.:');
  console.error('    WA_PAIR_NUMBER=601XXXXXXXX node server-http.js');
  process.exit(1);
}

// ── Single-instance guard ─────────────────────────────────────────────────────
const LOCK_FILE = path.join(__dirname, 'daemon.pid');
try {
  if (fs.existsSync(LOCK_FILE)) {
    const oldPid = parseInt((fs.readFileSync(LOCK_FILE, 'utf8') || '').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      let alive = false;
      try { process.kill(oldPid, 0); alive = true; } catch (_) {}
      if (alive) {
        console.error(`Another daemon (pid ${oldPid}) already running — exiting to avoid a duplicate.`);
        process.exit(0);
      }
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  const releaseLock = () => { try { if ((fs.readFileSync(LOCK_FILE, 'utf8') || '').trim() === String(process.pid)) fs.unlinkSync(LOCK_FILE); } catch (_) {} };
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
} catch (e) { console.error('lock guard error (continuing):', e.message); }

// ── WhatsApp client (singleton) ───────────────────────────────────────────────

const wa = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  takeoverOnConflict: true,
  takeoverTimeoutMs: 10000,
  puppeteer: { headless: true, protocolTimeout: 600000, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check'] }
});

let waReady = false;
let everReady = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECTS = 5;
const LOCK_CONFLICT_RE = /already running|SingletonLock|ProcessSingleton|browser is already/i;

const QR_PNG = path.join(__dirname, 'link-qr.png');
let pairingRequested = false;
let lastPairingCode = null;

wa.on('qr', async () => {
  if (pairingRequested) return;
  pairingRequested = true;
  try {
    const code = await wa.requestPairingCode(PAIR_NUMBER);
    lastPairingCode = code;
    console.error('\n📲 PAIRING CODE: ' + code);
    console.error(`Enter on phone (+${PAIR_NUMBER}): WhatsApp → Linked Devices → Link a Device → "Link with phone number instead"\n`);
  } catch (e) {
    console.error('Pairing code request failed:', e && e.message ? e.message : e);
    pairingRequested = false;
  }
});
wa.on('authenticated', () => { pairingRequested = false; lastPairingCode = null; console.error('✅ WhatsApp authenticated'); });
wa.on('auth_failure', (m) => { pairingRequested = false; console.error('❌ WhatsApp auth failure:', m); });
wa.on('ready', () => { waReady = true; everReady = true; reconnectAttempts = 0; pairingRequested = false; lastPairingCode = null; console.error('✅ WhatsApp ready'); });

function scheduleReconnect(reason) {
  waReady = false;
  if (LOCK_CONFLICT_RE.test(reason)) {
    console.error(`❌ Lock conflict (${reason}). Another instance owns the session — not retrying.`);
    return;
  }
  if (reconnectTimer) return;
  if (reconnectAttempts >= MAX_RECONNECTS) {
    console.error(`❌ Gave up after ${MAX_RECONNECTS} reconnects (${reason}). Relaunch daemon.`);
    return;
  }
  reconnectAttempts++;
  const gentle = !everReady;
  const delay = gentle ? 8000 : 15000;
  console.error(`⚠️  WhatsApp ${gentle ? 'still loading' : 'down'} (${reason}). Retry ${reconnectAttempts}/${MAX_RECONNECTS} in ${delay / 1000}s...`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try { await wa.destroy(); } catch (_) {}
    try { await wa.initialize(); } catch (e) { scheduleReconnect('retry: ' + e.message); }
  }, delay);
}

wa.on('disconnected', (reason) => scheduleReconnect(reason || 'disconnected'));

const FATAL_RE = /Execution context was destroyed|Session closed|Target closed|Protocol error|detached Frame|Frame was detached|Attempted to use detached/i;
process.on('unhandledRejection', (err) => {
  const msg = (err && err.message) || String(err);
  console.error('unhandledRejection:', msg);
  if (everReady && FATAL_RE.test(msg)) scheduleReconnect('context-destroyed');
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err.message);
  if (everReady && FATAL_RE.test(err.message)) scheduleReconnect('uncaught');
});

wa.initialize().catch((e) => scheduleReconnect('init-failed: ' + e.message));

// ── Shared helpers ────────────────────────────────────────────────────────────

function requireReady() {
  if (!waReady) throw new Error('WhatsApp not ready — check terminal for pairing instructions');
}

function fmtMsg(m) {
  const ts = new Date(m.timestamp * 1000).toLocaleString();
  const contact = m._data?.notifyName || m._data?.pushname || (m.author || m.from || '').split('@')[0] || 'contact';
  const who = m.fromMe ? 'ME (sent →)' : `${contact} (received ←)`;
  return `[${ts}] ${who}: ${m.body}`;
}

// ── Send throttle (anti-ban: keep sends human-paced) ─────────────────────────
const SEND_MIN_GAP_MS = [2500, 6000];
const SEND_MAX_PER_MIN = 10;
const SEND_MAX_PER_DAY = 120;
let lastSendAt = 0;
let sendWindow = [];
let sendDay = { date: null, count: 0 };
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));
const _rand = (a, b) => Math.floor(a + Math.random() * (b - a));
const _today = () => new Date().toISOString().slice(0, 10);

async function throttleSend() {
  const today = _today();
  if (sendDay.date !== today) sendDay = { date: today, count: 0 };
  if (sendDay.count >= SEND_MAX_PER_DAY)
    throw new Error(`Daily send cap reached (${SEND_MAX_PER_DAY}/day) — anti-ban guard.`);

  const now0 = Date.now();
  sendWindow = sendWindow.filter(t => now0 - t < 60000);
  if (sendWindow.length >= SEND_MAX_PER_MIN) {
    const waitMs = 60000 - (now0 - sendWindow[0]) + 250;
    console.error(`⏳ Rate cap — waiting ${Math.ceil(waitMs / 1000)}s`);
    await _sleep(waitMs);
  }

  const gap = _rand(SEND_MIN_GAP_MS[0], SEND_MIN_GAP_MS[1]);
  const since = Date.now() - lastSendAt;
  if (since < gap) await _sleep(gap - since);

  lastSendAt = Date.now();
  sendWindow.push(lastSendAt);
  sendDay.count++;
}

let _sendChain = Promise.resolve();
function throttledGate() {
  const run = _sendChain.then(throttleSend);
  _sendChain = run.catch(() => {});
  return run;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

const TOOLS = [
  { name: 'wa_get_chats', description: 'List recent WhatsApp chats (name, id, last message preview, unread count)',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max chats (default 20)' } } } },
  { name: 'wa_get_messages', description: 'Get recent messages from a chat by chat ID or contact name',
    inputSchema: { type: 'object', required: ['chat_id'], properties: {
      chat_id: { type: 'string', description: 'Chat ID (e.g. 60123456789@c.us) or partial contact name' },
      limit: { type: 'number', description: 'Messages to fetch (default 30)' } } } },
  { name: 'wa_send_message', description: 'Send a WhatsApp message to a contact or chat',
    inputSchema: { type: 'object', required: ['chat_id', 'message'], properties: {
      chat_id: { type: 'string', description: 'Chat ID or partial contact name' },
      message: { type: 'string', description: 'Message text' } } } },
  { name: 'wa_search_messages', description: 'Search across all chats for messages containing a keyword',
    inputSchema: { type: 'object', required: ['query'], properties: {
      query: { type: 'string', description: 'Keyword' },
      limit: { type: 'number', description: 'Max results (default 20)' } } } },
  { name: 'wa_status', description: 'Check if WhatsApp is connected and ready',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'wa_download_media', description: 'Download an attachment (document/image/audio/video) from a chat to disk and return the saved file path.',
    inputSchema: { type: 'object', required: ['chat_id'], properties: {
      chat_id: { type: 'string', description: 'Chat ID or partial contact name' },
      match: { type: 'string', description: 'Substring of the filename or caption to locate. Omit to grab the most recent media.' },
      limit: { type: 'number', description: 'How many recent messages to scan (default 50)' },
      type: { type: 'string', description: 'Filter by type: "audio", "image", "video". Omit for any.' },
      index: { type: 'number', description: 'Which match to return (0 = most recent). Default 0.' } } } },
  { name: 'wa_send_file', description: 'Send a file from local disk to a WhatsApp chat (PDF, docx, images, etc.), with an optional caption.',
    inputSchema: { type: 'object', required: ['chat_id', 'file_path'], properties: {
      chat_id: { type: 'string', description: 'Chat ID or partial contact name' },
      file_path: { type: 'string', description: 'Absolute local path to the file to send' },
      caption: { type: 'string', description: 'Optional caption text' } } } },
  { name: 'wa_get_poll_results', description: 'Get vote tally for a native WhatsApp poll in a chat.',
    inputSchema: { type: 'object', required: ['chat_id'], properties: {
      chat_id: { type: 'string', description: 'Chat ID or partial contact/group name' },
      match: { type: 'string', description: 'Substring of the poll question. Omit for the most recent poll.' },
      limit: { type: 'number', description: 'How many recent messages to scan (default 80)' } } } },
];

async function callTool(name, args) {
  args = args || {};
  try {
    if (name === 'wa_status')
      return { content: [{ type: 'text', text: waReady ? '✅ Connected and ready' : '⚠️ Not ready' }] };

    requireReady();

    if (name === 'wa_get_chats') {
      const chats = await wa.getChats();
      const limit = args.limit || 20;
      const lines = chats.slice(0, limit).map(c => {
        const last = c.lastMessage?.body?.slice(0, 60) || '(media/no message)';
        return `• ${c.name || c.id.user} [${c.id._serialized}] unread:${c.unreadCount} — "${last}"`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'wa_get_messages') {
      const limit = args.limit || 30;
      let chat;
      if (args.chat_id.includes('@')) chat = await wa.getChatById(args.chat_id);
      else {
        const chats = await wa.getChats();
        chat = chats.find(c => (c.name || '').toLowerCase().includes(args.chat_id.toLowerCase()));
        if (!chat) throw new Error(`No chat found matching "${args.chat_id}"`);
      }
      const messages = await chat.fetchMessages({ limit });
      const lines = await Promise.all(messages.map(async (m) => {
        let line = fmtMsg(m);
        if (m.hasQuotedMsg) {
          try {
            const q = await m.getQuotedMessage();
            const qwho = q.fromMe ? 'ME' : 'CONTACT';
            const qbody = (q.body || '(media/no text)').replace(/\s+/g, ' ').slice(0, 240);
            line += `\n      ↳ (replying to ${qwho}): "${qbody}"`;
          } catch (_) { line += `\n    ↳ [reply to a message]`; }
        }
        return line;
      }));
      return { content: [{ type: 'text', text: `── ${chat.name || chat.id.user} (${messages.length} messages) ──\n\n${lines.join('\n')}` }] };
    }

    if (name === 'wa_send_message') {
      let chatId = args.chat_id;
      if (!chatId.includes('@')) {
        const chats = await wa.getChats();
        const chat = chats.find(c => (c.name || '').toLowerCase().includes(chatId.toLowerCase()));
        if (!chat) throw new Error(`No chat found matching "${chatId}"`);
        chatId = chat.id._serialized;
      }
      await throttledGate();
      await wa.sendMessage(chatId, args.message);
      return { content: [{ type: 'text', text: `✅ Sent to ${chatId}` }] };
    }

    if (name === 'wa_send_file') {
      let chatId = args.chat_id;
      let chatLabel = chatId;
      if (!chatId.includes('@')) {
        const chats = await wa.getChats();
        const chat = chats.find(c => (c.name || '').toLowerCase().includes(chatId.toLowerCase()));
        if (!chat) throw new Error(`No chat found matching "${chatId}"`);
        chatId = chat.id._serialized;
        chatLabel = `${chat.name || chat.id.user} [${chatId}]`;
      }
      if (!fs.existsSync(args.file_path)) throw new Error(`File not found: ${args.file_path}`);
      const media = MessageMedia.fromFilePath(args.file_path);
      const opts = args.caption ? { caption: args.caption } : {};
      await throttledGate();
      await wa.sendMessage(chatId, media, opts);
      return { content: [{ type: 'text', text: `✅ Sent file ${path.basename(args.file_path)} to ${chatLabel}` }] };
    }

    if (name === 'wa_search_messages') {
      const limit = args.limit || 20;
      const results = await wa.searchMessages(args.query, { limit });
      if (!results.length) return { content: [{ type: 'text', text: 'No messages found.' }] };
      return { content: [{ type: 'text', text: results.map(m => `[${m.from || ''}] ${fmtMsg(m)}`).join('\n') }] };
    }

    if (name === 'wa_download_media') {
      const limit = args.limit || 50;
      let chat;
      if (args.chat_id.includes('@')) chat = await wa.getChatById(args.chat_id);
      else {
        const chats = await wa.getChats();
        chat = chats.find(c => (c.name || '').toLowerCase().includes(args.chat_id.toLowerCase()));
        if (!chat) throw new Error(`No chat found matching "${args.chat_id}"`);
      }
      const messages = await chat.fetchMessages({ limit });
      let media = messages.filter(m => m.hasMedia);
      if (!media.length) throw new Error(`No media messages in the last ${limit} messages`);

      if (args.type) {
        const waMimeMap = { audio: ['audio', 'ptt'], image: ['image'], video: ['video'], document: ['document'] };
        const prefixes = waMimeMap[args.type] || [args.type];
        media = media.filter(m => prefixes.some(p => (m.type || '').startsWith(p) || (m._data?.mimetype || '').startsWith(p)));
        if (!media.length) throw new Error(`No media of type "${args.type}" found`);
      }

      const idx = typeof args.index === 'number' ? args.index : 0;
      const sorted = [...media].reverse();

      let target;
      if (args.match) {
        const q = args.match.toLowerCase();
        const nameOf = (m) => (m._data?.filename || m.body || '').toLowerCase();
        const matches = sorted.filter(m => nameOf(m).includes(q));
        target = matches[idx];
        if (!target) throw new Error(`No media matching "${args.match}" at index ${idx}`);
      } else {
        target = sorted[idx];
        if (!target) throw new Error(`No media at index ${idx}`);
      }

      const dl = await target.downloadMedia();
      if (!dl || !dl.data) throw new Error('downloadMedia returned no data (may have expired)');

      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
      const ext = (dl.mimetype || '').split('/')[1]?.split(';')[0] || 'bin';
      const safeName = (dl.filename || target._data?.filename || `${target.id?.id || 'media'}.${ext}`).replace(/[\\/:*?"<>|]/g, '_');
      const outPath = path.join(DOWNLOAD_DIR, safeName);
      fs.writeFileSync(outPath, Buffer.from(dl.data, 'base64'));
      const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
      return { content: [{ type: 'text', text: `✅ Saved ${safeName} (${kb} KB) → ${outPath}` }] };
    }

    if (name === 'wa_get_poll_results') {
      const limit = args.limit || 80;
      let chat;
      if (args.chat_id.includes('@')) chat = await wa.getChatById(args.chat_id);
      else {
        const chats = await wa.getChats();
        chat = chats.find(c => (c.name || '').toLowerCase().includes(args.chat_id.toLowerCase()));
        if (!chat) throw new Error(`No chat found matching "${args.chat_id}"`);
      }
      const messages = await chat.fetchMessages({ limit });
      const polls = messages.filter(m => m.type === 'poll_creation');
      if (!polls.length) throw new Error(`No native poll in the last ${limit} messages`);
      let poll;
      if (args.match) {
        const q = args.match.toLowerCase();
        poll = [...polls].reverse().find(m => (m.pollName || '').toLowerCase().includes(q));
        if (!poll) throw new Error(`No poll matching "${args.match}"`);
      } else {
        poll = polls[polls.length - 1];
      }
      const votes = await poll.getPollVotes();
      const tally = {};
      (poll.pollOptions || []).forEach(o => { tally[o.name] = []; });
      for (const v of votes) {
        let voterName = (v.voter || '').split('@')[0];
        try { const c = await wa.getContactById(v.voter); voterName = c.pushname || c.name || c.number || voterName; } catch (_) {}
        (v.selectedOptions || []).forEach(opt => {
          if (!tally[opt.name]) tally[opt.name] = [];
          tally[opt.name].push(voterName);
        });
      }
      const totalVoters = new Set(votes.map(v => v.voter)).size;
      const lines = Object.entries(tally)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([opt, voters]) => `  ${voters.length}  ·  ${opt}${voters.length ? '   — ' + voters.join(', ') : ''}`);
      return { content: [{ type: 'text', text: `📊 Poll: "${poll.pollName}" (${totalVoters} voter(s))\n${lines.join('\n')}` }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
}

// ── MCP server factory ────────────────────────────────────────────────────────

function buildMcpServer() {
  const server = new Server({ name: 'whatsapp-mcp', version: '2.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(req.params.name, req.params.arguments));
  return server;
}

// ── HTTP transport ────────────────────────────────────────────────────────────

const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/qr' || req.url === '/qr/') {
    if (waReady) { res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h2 style="font-family:sans-serif">✅ WhatsApp linked and ready.</h2>'); return; }
    const html = `<!doctype html><meta http-equiv="refresh" content="10">` +
      `<body style="background:#111;color:#eee;font-family:sans-serif;text-align:center;padding-top:40px">` +
      `<h2>Link WhatsApp</h2>` +
      `<p>WhatsApp → Settings → Linked Devices → Link a Device → <b>Link with phone number instead</b></p>` +
      (lastPairingCode
        ? `<div style="font-size:42px;letter-spacing:8px;font-weight:bold;margin:24px;color:#25D366">${lastPairingCode}</div>`
        : `<p>Generating pairing code…</p>`) +
      `<p style="opacity:.6">Page refreshes every 10s.</p></body>`;
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
    return;
  }

  if (req.url !== '/mcp') { res.writeHead(404).end('Not found'); return; }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined; }
    catch { res.writeHead(400).end('Bad JSON'); return; }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { try { transport.close(); } catch (_) {} });
    try {
      const server = buildMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error('request error:', e.message);
      if (!res.headersSent) res.writeHead(500).end('Internal error');
    }
  });
});

httpServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use — daemon already running.`);
    process.exit(0);
  }
  console.error('HTTP server error:', e.message);
  process.exit(1);
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.error(`WhatsApp MCP HTTP daemon listening on http://127.0.0.1:${PORT}/mcp`);
});
