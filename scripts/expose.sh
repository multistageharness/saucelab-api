#!/usr/bin/env bash
# Run the HTTP server and a Cloudflare quick tunnel together; print the public MCP URL.
# Both processes stop on Ctrl-C. The trycloudflare hostname changes on every run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; PORT="${PORT:-50010}"
secret=$(grep -E '^MURAL_HTTP_SECRET=' "$ROOT/.env" | cut -d= -f2- || true)
[ -n "$secret" ] || { echo "MURAL_HTTP_SECRET missing — run 'make http-secret'"; exit 1; }

node "$ROOT/build/index.js" --http --port "$PORT" &
HTTP_PID=$!
cleanup() { kill "$HTTP_PID" "${TUN_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.2; done
curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null || { echo "HTTP server did not start"; exit 1; }

LOG="$(mktemp)"
npx --yes cloudflared@0.7.3 tunnel --url "http://127.0.0.1:$PORT" >"$LOG" 2>&1 &
TUN_PID=$!
host=""
for _ in $(seq 1 150); do
  host="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$host" ] && break; sleep 0.2
done
[ -n "$host" ] || { echo "tunnel did not report a URL; log:"; tail -20 "$LOG"; exit 1; }

echo
echo "================================================================"
echo "Public MCP endpoint (Streamable HTTP):"
echo
echo "  $host/$secret/mcp"
echo
echo "Gemini app : gemini.google.com -> Settings -> Connected apps -> Custom apps -> Add -> paste URL"
echo "ChatGPT    : Settings -> Connectors -> Advanced -> Developer mode -> Create -> paste URL (no auth)"
echo
echo "Anyone with this URL can read and edit your murals. Ctrl-C stops both server and tunnel."
echo "================================================================"
wait "$TUN_PID"
