# WhatsApp MCP for Claude Code

Let Claude read and interact with your WhatsApp — read messages, send replies, download attachments, search chats — all from inside Claude Code.

Uses your existing WhatsApp account. No WhatsApp Business API. No monthly cost.

---

## What it does

Once set up, Claude can:

- Read any chat or group (recent messages, full history)
- Send messages to any contact or group
- Search across all chats by keyword
- Download images, videos, documents, and voice notes from chats
- Send files to any chat
- Read native poll results

---

## How it works

It runs a small local program on your computer that mimics WhatsApp Web — the same thing that happens when you scan a QR code on WhatsApp. Instead of showing you a chat interface, it opens a private connection that Claude can use as a tool.

Nothing goes through a third-party server. It all stays on your machine.

**⚠️ Unofficial:** WhatsApp doesn't officially support this. The risk of getting your number banned is real if you mass-message strangers. For personal use (reading your own chats, replying to people you know), the risk is very low.

---

## Requirements

- [Node.js](https://nodejs.org) v18 or higher
- [Claude Code](https://claude.ai/code) installed
- A WhatsApp account linked to a phone

---

## Setup

### 1. Install

```bash
git clone https://github.com/YOUR_USERNAME/whatsapp-claude-mcp
cd whatsapp-claude-mcp
npm install
```

### 2. Start the daemon

**Windows:**
```
start.bat
```

**Mac / Linux:**
```bash
WA_PAIR_NUMBER=601XXXXXXXX sh start.sh
```

Replace `601XXXXXXXX` with your number in international format — no `+`, no spaces. Malaysian numbers start with `60`.

### 3. Link your phone (first time only)

When the daemon starts, it prints a pairing code in the terminal:

```
📲 PAIRING CODE: XXXX-XXXX
Enter on phone: WhatsApp → Linked Devices → Link a Device → "Link with phone number instead"
```

Enter the code on your phone. Takes about 10 seconds. After that, it remembers your session — you won't need to do this again.

### 4. Add to Claude Code

Open (or create) `~/.claude.json` and add:

```json
{
  "mcpServers": {
    "whatsapp": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

Restart Claude Code. You're done.

---

## Usage

Once running, just talk to Claude normally:

> "Read my last 20 messages from Alex"
> "What did the Founders group say today?"
> "Send this to Taylor: [message]"
> "Download the PDF Hezri sent me"

---

## Keep it running

The daemon needs to stay running in the background for Claude to access WhatsApp.

**Auto-start on Windows:** Drop a shortcut to `start.bat` in your Startup folder (`Win+R` → `shell:startup`).

**Mac:** Add it to Login Items, or use a launchd plist.

---

## Voice notes + media processing (optional)

To let Claude transcribe voice notes and extract video frames, set up the included `process_media.py` helper.

**1. Get a free AssemblyAI key** at [assemblyai.com](https://assemblyai.com) — $50 free credit on signup (~135 hours of audio, effectively free for personal use).

**2. Install dependencies:**
```bash
pip install requests
# Also install ffmpeg (for video): https://ffmpeg.org/download.html
```

**3. Set your API key:**
```bash
# Mac / Linux
export ASSEMBLYAI_API_KEY=your_key_here

# Windows
set ASSEMBLYAI_API_KEY=your_key_here
```

**4. Tell Claude how to use it** — add this to your Claude Code project instructions (`CLAUDE.md`):

```
When you download media from WhatsApp, run:
python /path/to/whatsapp-claude-mcp/process_media.py <file_path>
It prints what to do next (read the file, frame paths, or transcript).
```

After that, Claude handles everything automatically — downloads the voice note, transcribes it, reads the result.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `WA_PAIR_NUMBER` | Yes (first run) | — | Your WhatsApp number (e.g. `601XXXXXXXX`) |
| `WA_MCP_PORT` | No | `8765` | Port to listen on |
| `WA_DOWNLOAD_DIR` | No | `./wa-downloads` | Where downloaded media is saved |
| `ASSEMBLYAI_API_KEY` | For voice notes | — | Free at assemblyai.com |

---

## Troubleshooting

**"detached Frame" error in Claude** — the daemon's browser crashed. Kill and restart the daemon.

**Claude says WhatsApp not ready** — check that the daemon terminal shows `✅ WhatsApp ready`. If not, it's still loading or needs to be relinked.

**Pairing code not showing** — make sure `WA_PAIR_NUMBER` is set correctly and the number is active on WhatsApp.
