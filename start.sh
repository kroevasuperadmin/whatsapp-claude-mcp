#!/bin/sh
if [ -z "$WA_PAIR_NUMBER" ]; then
  printf "Enter your WhatsApp number (e.g. 601XXXXXXXX): "
  read WA_PAIR_NUMBER
  export WA_PAIR_NUMBER
fi
echo "Starting WhatsApp MCP daemon..."
node server-http.js
