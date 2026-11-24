#!/usr/bin/env bash
# Ensure MURAL_HTTP_SECRET exists in .env (generate a 48-hex-char one if missing). Prints nothing secret.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; ENV="$ROOT/.env"
[ -f "$ENV" ] || { cp "$ROOT/.env.example" "$ENV"; chmod 600 "$ENV"; }
if grep -qE '^MURAL_HTTP_SECRET=.+' "$ENV"; then echo "MURAL_HTTP_SECRET already set in .env"; exit 0; fi
secret=$(openssl rand -hex 24)
if grep -qE '^#? *MURAL_HTTP_SECRET=' "$ENV"; then
  sed -i '' -E "s|^#? *MURAL_HTTP_SECRET=.*|MURAL_HTTP_SECRET=$secret|" "$ENV"
else
  printf '\nMURAL_HTTP_SECRET=%s\n' "$secret" >> "$ENV"
fi
echo "MURAL_HTTP_SECRET generated and written to .env"
