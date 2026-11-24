# Keychain secret store: setup and validation

`mcp-mural` reads its `MURAL_*` credentials from the macOS login keychain through
[`macos-keychain-env`](https://github.com/multistageharness/macos-keychain-env), vendored at
`vendors/macos-keychain-env`. The directory is git-ignored and excluded from every publish, so each
checkout fetches it once with `make vendor`. This page covers getting that store working and proving
that it works. The resolution rules themselves are in the README's *Secret store* section and in
`src/secrets.ts`.

Nothing below prints a secret value. Every check reads presence or metadata only.

## 1. Prerequisites

| Requirement | Why |
|---|---|
| macOS | Items live in the login keychain and are read through `/usr/bin/security`. |
| Node.js 20.19 or newer | Engine floor of the vendored package. `node --version` |
| `git` and access to github.com | `make vendor` clones the public repository over HTTPS. |
| An unlocked login keychain | Normal for an interactive session. Over SSH it may be locked; see Troubleshooting. |

Linux, CI and any other environment skip the keychain entirely: set the variables directly or use
`.env`, and the loader falls back on its own (`MURAL_SECRETS_BACKEND=auto`).

## 2. Set up

### 2.1 Fetch the vendored package

```bash
make vendor
```

Clones `KEYCHAIN_ENV_REPO` at `KEYCHAIN_ENV_REF` (default: the repository above, branch `main`)
into `vendors/macos-keychain-env`, or fast-forwards an existing checkout. Both knobs are Makefile
variables, so a tag can be pinned:

```bash
KEYCHAIN_ENV_REF=v0.1.0 make vendor      # a branch or tag name
```

To use a checkout kept elsewhere instead of `vendors/`, point the server at it:

```bash
MURAL_KEYCHAIN_ENV_MODULE=/path/to/macos-keychain-env     # directory or its src/index.js
```

### 2.2 Store the OAuth client credentials

The client id and secret come from the integration you registered in the Mural Developer Portal.
Store each one through a hidden prompt. The value never appears on the command line or in shell
history.

```bash
make secret KEY=MURAL_CLIENT_ID
make secret KEY=MURAL_CLIENT_SECRET
```

`make secret` wraps `keychain-env set <service> <account>`. The service is `MURAL_KEYCHAIN_SERVICE`
(default `mural-mcp`) and the account is the variable name. Two alternatives when a prompt is
impractical:

```bash
# value is on the clipboard; cleared afterwards
node vendors/macos-keychain-env/bin/keychain-env.js set mural-mcp MURAL_CLIENT_SECRET --from-clipboard --clear-clipboard
# value arrives on stdin from another program
some-vault-cli read mural/client-secret | node vendors/macos-keychain-env/bin/keychain-env.js set mural-mcp MURAL_CLIENT_SECRET --stdin
```

### 2.3 Authorize

```bash
make auth
```

Opens the consent page, exchanges the code, and stores `MURAL_ACCESS_TOKEN`,
`MURAL_REFRESH_TOKEN` and `MURAL_TOKEN_EXPIRES_AT` in the keychain. From then on the server
refreshes the access token itself and writes each new token set back to the same items.

### 2.4 Optional: HTTP mode credentials

`MURAL_HTTP_SECRET` and `MURAL_HTTP_BEARER` are read from the keychain too:

```bash
make secret KEY=MURAL_HTTP_SECRET
```

`make http-secret` still generates a value into `.env`. A value in `.env` always wins over the
keychain, so pick one place for each variable.

### 2.5 Migrate an existing `.env`

The package can move values out of a `.env` into the keychain and leave references behind:

```bash
node vendors/macos-keychain-env/bin/keychain-env.js import .env --service mural-mcp
```

This stores the values, writes a `.env.keychain` manifest of `VAR=keychain://mural-mcp` lines, and
approves that manifest. `.env` itself is not modified. Because values present in `.env` shadow the
keychain, blank the migrated lines there (or delete the file) afterwards, otherwise the old copies
keep being used. The server honours a `.env.keychain` next to `package.json`; after any edit to it,
run the package's `trust` command again and review what it lists before approving.

### 2.6 Choosing the backend explicitly

| `MURAL_SECRETS_BACKEND` | Behaviour |
|---|---|
| `auto` (default) | Keychain when on macOS and the vendored module is present, otherwise `.env` only. |
| `keychain` | Keychain required. Startup fails with a pointer to `make vendor` if the module is missing. |
| `env` | Never touches the keychain. The smoke test uses this. |

Set it in the process environment or in `.env`; the latter works because the file is read before the
backend is chosen.

## 3. Validate

Run these from the `v200` directory after the setup above. Each step states what a pass looks like.

### 3.1 The vendored package is intact

```bash
git -C vendors/macos-keychain-env log --oneline -1       # the commit you expect
( cd vendors/macos-keychain-env && npm test )             # unit tests against a fake security binary
```

The test suite needs no `npm install` and never touches the real keychain. A pass ends with
`fail 0`; one test is skipped by design.

### 3.2 The expected items exist

```bash
make secrets
```

Prints the service name and one `present` or `missing` line per variable, reading no values. After
sections 2.2 and 2.3, the client id, client secret and the three token items should be `present`.
The HTTP items are only needed for `--http`.

The same check for a single item, with the exit code as the answer:

```bash
node vendors/macos-keychain-env/bin/keychain-env.js has mural-mcp MURAL_CLIENT_ID; echo $?
# 0 = present, 1 = missing
/usr/bin/security find-generic-password -s mural-mcp -a MURAL_CLIENT_ID >/dev/null 2>&1; echo $?
# 0 = present, 44 = not found (raw fallback, no package involved)
```

### 3.3 The server resolves through the keychain

Start the server once and read its first stderr line:

```bash
make build
node build/index.js        # Ctrl-C after the "starting" line
```

A pass contains `secrets=keychain (service "mural-mcp"; from keychain: MURAL_CLIENT_ID,...)`. The
list names every variable that came from the keychain. A variable missing from it was either not in
the keychain or was already set in the environment or `.env`, which win.

Force the strict mode to prove the dependency is real:

```bash
MURAL_SECRETS_BACKEND=keychain node build/index.js
```

With the vendor removed, this exits with code 1 and an error naming `make vendor`; with
`MURAL_KEYCHAIN_ENV_MODULE` pointing nowhere, the error names that path. With the vendor in place it
starts normally.

Then exercise the API end to end with a board you can read:

```bash
make probe BOARD=<workspace>.<id>
```

### 3.4 Write-back works

After `make auth`, `make secrets` reports the three token items `present`. After the first automatic
refresh (the server logs `access token refreshed`), the modification date of the items advances;
`find-generic-password` without `-g` or `-w` prints attributes only, including `mdat`:

```bash
/usr/bin/security find-generic-password -s mural-mcp -a MURAL_TOKEN_EXPIRES_AT | grep mdat
```

### 3.5 Nothing leaks into git or a publish

```bash
git check-ignore -v vendors/macos-keychain-env/package.json   # matched by .gitignore: vendors/
git status --short                                             # vendors/ must not appear
./.ci/sync.sh --dry-run                                        # copy set lists no vendors/ path
```

## 4. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `macos-keychain-env was not found ... Run make vendor` | Strict mode without the vendor | `make vendor`, or set `MURAL_KEYCHAIN_ENV_MODULE` |
| Startup line says `secrets=env` on a Mac | Vendor missing, so `auto` fell back | `make vendor`; confirm with `ls vendors/macos-keychain-env/src/index.js` |
| `hold keychain:// references but the keychain backend is not active` | `.env` contains `keychain://` values while the backend is `env` | Set `MURAL_SECRETS_BACKEND=keychain` or replace the references with plain values |
| `UNSUPPORTED_PLATFORM` | Keychain lookup attempted off macOS | Set the variables directly or use `.env`; `auto` already does this |
| `INTERACTION_NOT_ALLOWED` or `security` exit 36 | Login keychain locked (typical over SSH) | `/usr/bin/security unlock-keychain ~/Library/Keychains/login.keychain-db` |
| A GUI prompt, or `TIMEOUT` after 30 s | The item does not trust `/usr/bin/security` | Answer the prompt with *Always Allow*; items created by `make secret` trust it by default |
| `UNTRUSTED_MANIFEST` | `.env.keychain` was added or edited | Review and approve with `keychain-env trust` (`--manifest` for another path) |
| `SERVICE_NOT_ALLOWED` | A `keychain://` reference names a service other than `MURAL_KEYCHAIN_SERVICE` | Use the configured service, or move the item |
| New tokens are not being used | A stale copy in `.env` or the environment shadows the keychain | Blank that line; in keychain mode the server also updates lines `.env` already defines |
| `make secrets` shows `missing` right after `make secret` | Different service name | Check `MURAL_KEYCHAIN_SERVICE` in the environment and `.env` matches the one used to store |
| `Cannot find module` with a doubled `vendors/...` path | Command run from inside `vendors/macos-keychain-env` | Run from the `v200` directory, or use absolute paths |

Error messages from the package never contain secret values.

## 5. Update, pin, remove

```bash
make vendor                           # fast-forward to the latest commit on KEYCHAIN_ENV_REF
KEYCHAIN_ENV_REF=<tag> make vendor    # fresh checkout at a tag (remove the old one first)
rm -rf vendors/macos-keychain-env     # removes the code only; keychain items are untouched
```

Deleting keychain items is destructive and not reversible:

```bash
node vendors/macos-keychain-env/bin/keychain-env.js delete mural-mcp MURAL_REFRESH_TOKEN
```

## 6. Reference

| Variable | Default | Role |
|---|---|---|
| `MURAL_SECRETS_BACKEND` | `auto` | `auto`, `keychain` or `env` |
| `MURAL_KEYCHAIN_SERVICE` | `mural-mcp` | Keychain service that holds the items |
| `MURAL_KEYCHAIN_ENV_MODULE` | `vendors/macos-keychain-env` | Alternate location of the package |
| `MURAL_PERSIST_TOKENS` | `true` | `false` keeps refreshed tokens in memory only |

Items read from the keychain, all optional at the loader level: `MURAL_CLIENT_ID`,
`MURAL_CLIENT_SECRET`, `MURAL_ACCESS_TOKEN`, `MURAL_REFRESH_TOKEN`, `MURAL_TOKEN_EXPIRES_AT`,
`MURAL_HTTP_SECRET`, `MURAL_HTTP_BEARER`. `src/config.ts` then applies the usual rule: an access
token, or a refresh token plus client id and secret, must be available from some source.

Package documentation: `vendors/macos-keychain-env/README.md` after `make vendor`, or the
repository linked at the top.
