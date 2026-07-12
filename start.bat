@echo off
cd /d %~dp0
if "%WA_PAIR_NUMBER%"=="" (
  set /p WA_PAIR_NUMBER="Enter your WhatsApp number (e.g. 601XXXXXXXX): "
)
echo Starting WhatsApp MCP daemon...
echo Leave this window OPEN. It links once and remembers you after that.
node server-http.js
pause
