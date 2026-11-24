# mcp-mural

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the
[Mural](https://mural.co) Public API as tools. It speaks JSON-RPC 2.0 over **stdio** (default) or
**Streamable HTTP** using `@modelcontextprotocol/sdk`, calls the Mural Public API over HTTPS, and
takes every credential and deployment-specific value from the **macOS keychain, the environment or a
`.env` file**. Nothing account-, user- or organisation-specific is hardcoded.

```
MCP host (any stdio or Streamable HTTP client)
        │  JSON-RPC 2.0
        ▼
build/index.js  ──  StdioServerTransport | StreamableHTTPServerTransport
        │           27 mural_* tools (read, create, update, delete, draw, snapshot)
        ▼  HTTPS REST (Bearer token, auto-refresh)
$MURAL_API_BASE_URL  (default https://app.mural.co/api/public/v1)
```

## Requirements

- Node.js 20.19 or newer.
- macOS for the keychain secret store (the default). Elsewhere, or with `MURAL_SECRETS_BACKEND=env`,
  secrets come from the environment or `.env`.
- A Mural OAuth integration (client id and secret) created in the Mural Developer Portal, with the
  scopes listed in `.env.example` enabled and a redirect URI that matches `MURAL_REDIRECT_URI`.
- Optional, for PNG rendering in `mural_snapshot` and `scripts/snapshot.mjs`: `sips` (ships with
  macOS) or `pdftoppm` (poppler-utils). Without either, the PDF export is still returned.

## Quick start

```bash
make vendor                          # clone vendors/macos-keychain-env (keychain secret store; git-ignored)
make secret KEY=MURAL_CLIENT_ID      # store the OAuth client id in the keychain (hidden prompt)
make secret KEY=MURAL_CLIENT_SECRET
make auth                            # OAuth consent in the browser; tokens are stored in the keychain
make build                           # tsc -> build/
make smoke                           # offline end-to-end test against a mock API (no credentials needed)
```

Without macOS, or with `MURAL_SECRETS_BACKEND=env`: `make env`, fill in `.env`, then `make auth`.
Run `make` with no target to list every target.

## Configuration

All configuration is read from the process environment, falling back to the first `.env` file
found in this order. Values already present in the process environment always win.

1. `MURAL_ENV_FILE` (explicit path; when set, no other location is tried)
2. `<package root>/.env` (the directory containing `package.json`; works regardless of the cwd the
   MCP host launches the server from)
3. `<cwd>/.env`

### Secret store

Credentials are resolved in three layers. A value already present wins at each step.

1. The process environment (CI, an MCP host's `env` block).
2. The `.env` file above.
3. The macOS login keychain, read through the vendored
   [`macos-keychain-env`](https://github.com/multistageharness/macos-keychain-env) package in
   `vendors/macos-keychain-env`. `make vendor` clones or updates it; `vendors/` is git-ignored and
   never published. Items are generic passwords with service `MURAL_KEYCHAIN_SERVICE` (default
   `mural-mcp`) and account = variable name, for `MURAL_CLIENT_ID`, `MURAL_CLIENT_SECRET`,
   `MURAL_ACCESS_TOKEN`, `MURAL_REFRESH_TOKEN`, `MURAL_TOKEN_EXPIRES_AT`, `MURAL_HTTP_SECRET`
   and `MURAL_HTTP_BEARER`.

`MURAL_SECRETS_BACKEND` picks the store that fills the gaps and receives refreshed tokens:
`auto` (default: keychain on macOS when the vendored module is present, otherwise `.env`),
`keychain` (fail at startup if the module is missing) or `env` (never touch the keychain; the smoke
test uses this). Store a value through a hidden prompt, so it never reaches argv or shell history:

```bash
make secret KEY=MURAL_CLIENT_ID
make secret KEY=MURAL_CLIENT_SECRET
make secrets                     # which items exist; reads no values
```

`make auth` and the automatic token refresh write new tokens back to the active store. In keychain
mode a loaded `.env` that already defines a token line is updated too, so a stale copy cannot
shadow the keychain on the next start. `.env` may also hold references such as
`MURAL_ACCESS_TOKEN=keychain://mural-mcp`, which the package resolves. A `.env.keychain` manifest
next to `package.json` is honoured as well and must be approved once with the package's
`keychain-env trust` command. The implementation is `src/secrets.ts`; setup and validation steps are in
[`docs/keychain-env.md`](docs/keychain-env.md).

| Variable | Required | Purpose |
|---|---|---|
| `MURAL_CLIENT_ID` | for auth / refresh | OAuth integration client id |
| `MURAL_CLIENT_SECRET` | for auth / refresh | OAuth integration client secret |
| `MURAL_ACCESS_TOKEN` | yes, unless a refresh token and client credentials are present | Bearer token sent on every API call |
| `MURAL_REFRESH_TOKEN` | no | Enables automatic refresh; written by `npm run auth` |
| `MURAL_TOKEN_EXPIRES_AT` | no | Epoch milliseconds; enables proactive refresh; written by `npm run auth` |
| `MURAL_REDIRECT_URI` | no | Loopback redirect URI for `npm run auth`; default `http://localhost:50000/callback`; must equal the URI registered on the integration |
| `MURAL_SCOPES` | no | Space- or comma-separated scope list requested by `npm run auth`; defaults to the list in `src/config.ts` |
| `MURAL_AUTH_TIMEOUT_MINUTES` | no | How long `npm run auth` waits for the callback; default `10` |
| `MURAL_API_BASE_URL` | no | Default `https://app.mural.co/api/public/v1` |
| `MURAL_OAUTH_AUTHORIZE_URL` / `MURAL_OAUTH_TOKEN_URL` / `MURAL_OAUTH_REFRESH_URL` | no | Override the OAuth endpoints derived from the base URL |
| `MURAL_PERSIST_TOKENS` | no | `false` keeps refreshed tokens in memory instead of writing them back to the secret store |
| `MURAL_REQUEST_TIMEOUT_MS` | no | Per-request timeout; default `30000` |
| `MURAL_ENV_FILE` | no | Explicit `.env` path (see lookup order) |
| `MURAL_SECRETS_BACKEND` | no | `auto` (default), `keychain` or `env`; see Secret store |
| `MURAL_KEYCHAIN_SERVICE` | no | Keychain service holding the `MURAL_*` items; default `mural-mcp` |
| `MURAL_KEYCHAIN_ENV_MODULE` | no | Path to a `macos-keychain-env` checkout when it is not at `vendors/macos-keychain-env` |
| `MURAL_HTTP_HOST` / `MURAL_HTTP_PORT` | no | Bind address and port for `--http`; defaults `127.0.0.1` / `50010` |
| `MURAL_HTTP_SECRET` | no | Moves the HTTP endpoint from `/mcp` to `/<secret>/mcp` (capability URL) |
| `MURAL_HTTP_BEARER` | no | Requires `Authorization: Bearer <value>` on every HTTP request |

If no usable credentials are found the process exits with code 1 and prints the locations it
checked to stderr. `.env` is git-ignored.

## Authentication

Mural uses the OAuth 2.0 authorization-code grant. Access tokens are short-lived, so the server
needs a refresh token to run unattended.

- **`npm run auth`** (`src/auth.ts`) starts a temporary loopback listener on `MURAL_REDIRECT_URI`,
  opens the consent page for the configured scopes, exchanges the returned code, and stores
  `MURAL_ACCESS_TOKEN`, `MURAL_REFRESH_TOKEN` and `MURAL_TOKEN_EXPIRES_AT` in the active secret
  store (keychain on macOS, otherwise `.env`). Flags:
  `--no-open` prints the URL instead of launching a browser; `--env PATH` writes elsewhere.
  Every requested scope must be enabled on the integration, otherwise the provider returns
  `error=invalid_scope`.
- **Manual token.** Set `MURAL_ACCESS_TOKEN` yourself. Without a refresh token the server works
  until the token expires, then returns 401 errors.
- **Automatic refresh** (`src/mural-client.ts`). When `MURAL_REFRESH_TOKEN`, `MURAL_CLIENT_ID` and
  `MURAL_CLIENT_SECRET` are all present, the client refreshes before the recorded expiry and on any
  401, retries the request once, and persists the new tokens to the secret store (the keychain, or
  the `.env` it loaded) unless `MURAL_PERSIST_TOKENS=false`. Refresh is single-flight across
  concurrent requests.

## Transports

**stdio** (default): `node build/index.js`. Only MCP frames go to stdout; diagnostics go to stderr.

**Streamable HTTP**: `node build/index.js --http [--port N] [--host H]` or `make http`. Sessions are
stateful (`mcp-session-id`), one `McpServer` per session sharing a single API client. `GET /healthz`
returns `ok`. The server binds loopback by default; to expose it, put a TLS tunnel or reverse proxy
in front and set `MURAL_HTTP_SECRET` and/or `MURAL_HTTP_BEARER`. Anyone who can reach the endpoint
can act with the configured token, and the server logs a warning when bound to a non-loopback
address with neither protection. `make http-secret` generates the secret; `make expose` runs the
server plus a Cloudflare quick tunnel and prints the public URL.

## Tools

| Tool | Scope | What it does |
|---|---|---|
| `mural_list_workspaces` | `workspaces:read` | Lists workspaces visible to the token (`limit`, `next`). |
| `mural_list_rooms` / `mural_list_murals` | `rooms:read` | Navigate workspace → rooms → boards. |
| `mural_create_board` / `mural_duplicate_board` / `mural_update_board` | `rooms:write`, `murals:write` | Board lifecycle (the API has no delete). |
| `mural_get_board` | `murals:read` | Dimensions, title, workspace/room ids, metadata. |
| `mural_get_widgets` | `murals:read` | Every canvas element, auto-paginated; `type` / `parentId` filters; `next` for a single page. |
| `mural_get_widget` | `murals:read` | One widget with all properties. |
| `mural_create_sticky_note` | `murals:write` | Sticky note at `(x, y)` with text, shape and colour. |
| `mural_create_shape` | `murals:write` | True shapes (geometric, block arrows, bubbles, flowchart set) with text, fill, border width/style. |
| `mural_create_textbox` / `mural_create_title` | `murals:write` | Free text (simple HTML) and headings; font, size, alignment, background. |
| `mural_create_arrow` | `murals:write` | Lines and arrows from points; straight/curved/orthogonal/bezier; tip, colour, width, dash; `startRefId`/`endRefId` to attach to widgets. |
| `mural_create_area` | `murals:write` | Titled container; children via `parentId`. |
| `mural_create_table` | `murals:write` | Table from a grid of strings; fonts, alignment, header row. |
| `mural_create_image` / `mural_create_file` | `murals:write` | Upload from URL or base64 through the asset store, then place. |
| `mural_create_comment` | `murals:write` | Pinned comment. |
| `mural_list_tags` / `mural_create_tag` | `murals:*` | Tags for sticky notes. |
| `mural_update_widget` | `murals:write` | PATCH text, geometry, rotation, style, parent on any widget; type auto-detected or passed. |
| `mural_delete_widget` | `murals:write` | Deletes any widget (an area's children go with it). |
| `mural_draw` | `murals:write` | Batch: up to 200 primitives with handles; arrows auto-routed and attached between handles; stops at first failure and reports what was placed. |
| `mural_create_widgets_raw` | `murals:write` | Escape hatch: raw POST to any `/widgets/{type}`. |
| `mural_snapshot` | `murals:read` | Current PNG of the board (PDF export rasterised locally), returned as image content; the provider's cached thumbnail only as a labelled stale fallback. |
| `mural_export_pdf` | `murals:read` | PDF export with a time-limited URL. |

Every API failure is returned as a tool error (`isError: true`) with the HTTP status, a hint for
401/403/404, and the response body. Colours accept names (`yellow`, `blue`, `light green`, …) or
hex `#RRGGBB` / `#RRGGBBAA` and are normalised to `#RRGGBBAA`. Rotation pivots on the widget's
top-left corner; pass `anchor: "center"` to position by the visual centre. **AGENT.md** is the
drawing guide: coordinate system, capability matrix, batch recipes and the API limitations the code
works around.

## Live API behaviour encoded in the code

- Single objects come back wrapped as `{ value: {...} }`; the client unwraps both wrapped and bare
  shapes.
- `sticky-note`, `shape`, `textbox` and `title` bodies are arrays; `arrow`, `area`, `table`,
  `image`, `file` and `comment` bodies are single objects.
- Shapes accept `backgroundColor`, `borderWidth`, `borderStyle` (`solid` | `dotted`) but reject
  `borderColor`, `fontSize` and `textAlign`.
- The widget list `type` filter takes plural names; singular and path forms are mapped.
- `GET /exports/{id}` returns 404 while the export is still rendering; the tools poll.
- The board `thumbnailUrl` is a cached image refreshed rarely; it is never presented as current.
- Refresh requests must not include `scope`.

## Scripts and Makefile targets

| Command | Purpose |
|---|---|
| `npm run build` / `npm run check` | Compile to `build/` / type-check only |
| `make vendor` | Clone or update `vendors/macos-keychain-env` (git-ignored) |
| `make secret KEY=<name>` / `make secrets` | Store one keychain item through a hidden prompt / list which items exist |
| `npm run smoke` / `make smoke` | Offline end-to-end test: boots the server over stdio against a mock API and exercises the tools, including 401 → refresh → retry and `.env` persistence |
| `make probe BOARD=<id>` | Live read-only probe: workspaces, board, widgets |
| `make probe-write BOARD=<id>` | Live write probe: creates and updates one sticky note |
| `make snapshot BOARD=<id>` | Timestamped JSON + PDF + PNG snapshot under `.artifacts/mural/<id>/<stamp>/` with a diff against the previous one |
| `make register` / `make unregister` / `make status` | Claude Code `mcp add` / `remove` / `get` for this checkout |
| `make integrations` / `make verify-integrations` | Run every add / verify skill script below |
| `make http` / `make http-secret` / `make tunnel` / `make expose` | Streamable HTTP server, secret generation, tunnel, both together |
| `make clean` / `make clean-backups` | Remove `build/` / remove config backups the add scripts wrote |

Board ids have the form `<workspace>.<number>` and appear in a board URL after `/m/<workspace>/`.

## Client registration skills

`.claude/skills/` ships one `add` and one `verify` skill per client, each backed by an idempotent
shell script that resolves `node` to an absolute path (GUI apps do not inherit a shell PATH), points
at this checkout's `build/index.js`, and backs up any config file it edits. Verify scripts are
read-only and exit non-zero when something is broken.

| Client | add | verify |
|---|---|---|
| Claude Code | `integration-claude-code-add` | `integration-claude-code-verify` |
| Claude Desktop | `integration-claude-desktop-add` | `integration-claude-desktop-verify` |
| Gemini CLI | `integration-gemini-cli-add` | `integration-gemini-cli-verify` |
| Codex CLI / ChatGPT desktop (Codex mode) | `integration-chatgpt-codex-add` | `integration-chatgpt-codex-verify` |

Two more skills cover drawing: `mural-snapshot` (board snapshot with diff) and
`mural-drawing-geometry` (rotation pivot, rotated bounds, stacked-shape pitfalls).

Manual registration for any stdio client is a command plus arguments:

```
command: /ABSOLUTE/PATH/TO/node
args:    ["/ABSOLUTE/PATH/mcp-mural/build/index.js"]
```

With `.env` present next to `package.json` nothing else is needed; an `env` block in the client
config overrides the file.

## Project layout

```
src/index.ts         MCP server, tool registry, stdio / http entrypoint
src/config.ts        .env discovery, configuration, default scopes
src/secrets.ts       secret store: environment -> .env -> macOS keychain (vendored macos-keychain-env), write-back
src/mural-client.ts  typed client over the Mural Public API: auth refresh, pagination, unwrap
src/oauth.ts         authorize URL, code exchange, refresh, .env upsert
src/auth.ts          `npm run auth` one-shot OAuth callback helper
src/http.ts          Streamable HTTP transport (--http): secret path, bearer, sessions
src/widgets.ts       shape / textbox / title / arrow / area / delete / raw tools
src/board-tools.ts   rooms, murals, export, snapshot, tags, image/file upload, comments
src/draw-tools.ts    mural_draw batch primitives, tables
src/geometry.ts      rotation pivot conversion (top-left <-> centre), rotated bounds
src/render.ts        PDF export + local rasterisation (sips / pdftoppm)
src/colors.ts        colour name / hex normalisation
AGENT.md             drawing guide, capability matrix, API limitations
scripts/smoke.mjs    stdio + mock-API smoke test
scripts/probe.mjs    live probe through the stdio server (--write adds a sticky note)
scripts/snapshot.mjs temporal JSON snapshot of a board
scripts/http-secret.sh / expose.sh   HTTP secret generation; http + tunnel runner
docs/keychain-env.md keychain secret store: setup, validation, troubleshooting
.claude/skills/      client add / verify skills, snapshot and geometry skills
vendors/             git-ignored checkouts fetched by `make vendor` (macos-keychain-env)
```

Diagnostics are written to **stderr only**; stdout carries MCP protocol frames exclusively.
