#!/usr/bin/env node
/**
 * `npm run auth` — one-shot OAuth helper.
 *
 * 1. Starts a temporary HTTP listener on the registered redirect URI
 *    (MURAL_REDIRECT_URI, default DEFAULT_REDIRECT_URI in config.ts).
 * 2. Opens the Mural consent page requesting the configured scopes
 *    (MURAL_SCOPES, else the defaults in config.ts).
 * 3. Receives the code, exchanges it for tokens, and stores
 *    MURAL_ACCESS_TOKEN / MURAL_REFRESH_TOKEN / MURAL_TOKEN_EXPIRES_AT in the active
 *    secret store: the macOS keychain (vendors/macos-keychain-env) or .env.
 *    src/secrets.ts explains how the store is chosen (MURAL_SECRETS_BACKEND).
 *
 * Flags:  --no-open   do not launch a browser, just print the URL
 *         --env PATH  read/write this .env instead of the package-root one
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_API_BASE_URL, DEFAULT_REDIRECT_URI, configuredScopes, loadEnvFile } from "./config.js";
import { buildAuthorizeUrl, defaultEndpoints, exchangeCode, randomState } from "./oauth.js";
import { loadSecrets } from "./secrets.js";

const args = process.argv.slice(2);
const noOpen = args.includes("--no-open");
const envFlag = args.indexOf("--env");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = envFlag >= 0 && args[envFlag + 1] ? resolve(args[envFlag + 1]) : resolve(process.env.MURAL_ENV_FILE ?? resolve(packageRoot, ".env"));

// Client id/secret: process env wins, then the .env file, then the keychain (macOS).
if (envFlag >= 0) process.env.MURAL_ENV_FILE = envPath; // --env pins the file for reading and writing
const envFile = loadEnvFile();
const secrets = await loadSecrets({ envFile, envTarget: envFile ?? envPath });

const clientId = process.env.MURAL_CLIENT_ID?.trim();
const clientSecret = process.env.MURAL_CLIENT_SECRET?.trim();
const redirectUri = process.env.MURAL_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI;
const apiBaseUrl = (process.env.MURAL_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
const ep = defaultEndpoints(apiBaseUrl);
if (process.env.MURAL_OAUTH_AUTHORIZE_URL) ep.authorizeUrl = process.env.MURAL_OAUTH_AUTHORIZE_URL;
if (process.env.MURAL_OAUTH_TOKEN_URL) ep.tokenUrl = process.env.MURAL_OAUTH_TOKEN_URL;
if (process.env.MURAL_OAUTH_REFRESH_URL) ep.refreshUrl = process.env.MURAL_OAUTH_REFRESH_URL;

if (!clientId || !clientSecret) {
  console.error(
    "MURAL_CLIENT_ID and MURAL_CLIENT_SECRET are required.\n" +
      (secrets.backend === "keychain"
        ? `Store them with \`make secret KEY=MURAL_CLIENT_ID\` and \`make secret KEY=MURAL_CLIENT_SECRET\` (keychain service "${secrets.service}"), or put them in ${envPath}, then re-run \`npm run auth\`.`
        : `Put them in ${envPath} (see .env.example) or export them, then re-run \`npm run auth\`.`),
  );
  process.exit(1);
}

const redirect = new URL(redirectUri);
if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(redirect.hostname)) {
  console.error(`This helper only serves loopback redirect URIs; got ${redirectUri}. Set MURAL_REDIRECT_URI to http://localhost:<port>/<path>.`);
  process.exit(1);
}
const port = Number(redirect.port || (redirect.protocol === "https:" ? 443 : 80));
const state = randomState();
const scopes = configuredScopes();
const authorizeUrl = buildAuthorizeUrl(ep, { clientId, redirectUri, scopes, state });

const html = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;padding:2rem"><h1>${title}</h1><p>${body}</p></body>`;

const handler = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  console.error(`[auth] ${req.method} ${url.pathname}${url.search ? "?" + [...url.searchParams.keys()].join(",") : ""} from ${req.socket.remoteAddress}`);
  if (url.pathname !== redirect.pathname) {
    res.writeHead(404, { "content-type": "text/html" });
    return res.end(html("Not found", `Waiting for the callback on <code>${redirect.pathname}</code>.`));
  }
  const err = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const gotState = url.searchParams.get("state");
  if (err || !code) {
    res.writeHead(400, { "content-type": "text/html" });
    res.end(html("Authorization failed", `${err ?? "no code"}: ${url.searchParams.get("error_description") ?? ""}`));
    return finish(new Error(`authorization failed: ${err ?? "no code in callback"}`));
  }
  if (gotState !== state) {
    res.writeHead(400, { "content-type": "text/html" });
    res.end(html("State mismatch", "The callback did not match this session. Re-run npm run auth."));
    return finish(new Error("state mismatch (possible CSRF or stale tab)"));
  }
  try {
    const tokens = await exchangeCode(ep, { clientId, clientSecret, redirectUri, code });
    const saved: Record<string, string | undefined> = {
      MURAL_ACCESS_TOKEN: tokens.accessToken,
      MURAL_REFRESH_TOKEN: tokens.refreshToken,
      MURAL_TOKEN_EXPIRES_AT: tokens.expiresAt ? String(tokens.expiresAt) : undefined,
    };
    // In .env mode the file is the whole configuration, so keep the client settings there too.
    if (secrets.backend === "env") Object.assign(saved, { MURAL_CLIENT_ID: clientId, MURAL_CLIENT_SECRET: clientSecret, MURAL_REDIRECT_URI: redirectUri });
    await secrets.persist(saved);
    const where = secrets.backend === "keychain" ? `keychain service "${secrets.service}"` : secrets.envTarget;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html("Mural authorized", "Tokens saved. You can close this tab and return to the terminal."));
    console.error(
      `\nSaved to ${where}:` +
        `\n  MURAL_ACCESS_TOKEN     (${tokens.accessToken.length} chars)` +
        `\n  MURAL_REFRESH_TOKEN    ${tokens.refreshToken ? "yes" : "NOT RETURNED — token will not auto-refresh"}` +
        `\n  MURAL_TOKEN_EXPIRES_AT ${tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : "unknown"}` +
        (tokens.scope ? `\n  scopes: ${tokens.scope}` : ""),
    );
    finish();
  } catch (e) {
    res.writeHead(500, { "content-type": "text/html" });
    res.end(html("Token exchange failed", e instanceof Error ? e.message : String(e)));
    finish(e instanceof Error ? e : new Error(String(e)));
  }
};

// Browsers resolve "localhost" to ::1 and/or 127.0.0.1; serve both loopback families.
const servers = [createServer(handler), createServer(handler)];
const server = { close: () => servers.forEach((s) => s.close()) };

let done = false;
function finish(err?: Error) {
  if (done) return;
  done = true;
  server.close();
  clearTimeout(deadline);
  if (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

const TIMEOUT_MIN = Number(process.env.MURAL_AUTH_TIMEOUT_MINUTES) > 0 ? Number(process.env.MURAL_AUTH_TIMEOUT_MINUTES) : 10;
const deadline = setTimeout(() => finish(new Error(`Timed out after ${TIMEOUT_MIN} minutes waiting for the callback.`)), TIMEOUT_MIN * 60_000);

const hosts = redirect.hostname === "localhost" ? ["127.0.0.1", "::1"] : [redirect.hostname];
let listening = 0;
servers.slice(0, hosts.length).forEach((srv, i) => {
  srv.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.error(`Port ${port} on ${hosts[i]} is already in use. Stop whatever is listening there or set MURAL_REDIRECT_URI to a free port (and register it in the Mural Developer Portal).`);
      process.exit(1);
    }
    if (e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT") {
      console.error(`[auth] ${hosts[i]} unavailable on this machine; continuing without it.`);
      return;
    }
    console.error(e.message);
    process.exit(1);
  });
  srv.listen(port, hosts[i], () => {
    console.error(`[auth] listening on ${hosts[i]}:${port}`);
    if (++listening === 1) onReady();
  });
});

function onReady() {
  console.error(`Listening on ${redirectUri} for the OAuth callback (${TIMEOUT_MIN} minute timeout).`);
  console.error(`Scopes requested: ${scopes.join(" ")}`);
  console.error(`\nOpen this URL in your browser if it does not open automatically:\n\n  ${authorizeUrl}\n`);
  if (!noOpen) openBrowser(authorizeUrl);
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  } catch {
    /* user will use the printed URL */
  }
}
