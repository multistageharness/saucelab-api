/**
 * Mural OAuth 2.0 (authorization-code grant) helpers.
 *
 * Documented endpoints (developers.mural.co/public/docs/oauth):
 *   authorize  GET  https://app.mural.co/api/public/v1/authorization/oauth2/
 *   token      POST https://app.mural.co/api/public/v1/authorization/oauth2/token   (form-encoded)
 *   refresh    POST same URL with grant_type=refresh_token
 * Older integrations used POST .../authorization/oauth2/refresh; we fall back to it.
 * Responses may be snake_case (access_token) or camelCase (accessToken) — both are accepted.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

export interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  refreshUrl: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number; // seconds
  expiresAt?: number; // epoch ms
  scope?: string;
  raw: unknown;
}

export function defaultEndpoints(apiBaseUrl: string): OAuthEndpoints {
  const base = apiBaseUrl.replace(/\/+$/, "");
  return {
    authorizeUrl: `${base}/authorization/oauth2/`,
    tokenUrl: `${base}/authorization/oauth2/token`,
    refreshUrl: `${base}/authorization/oauth2/refresh`,
  };
}

export function randomState(): string {
  return randomBytes(16).toString("hex");
}

export function buildAuthorizeUrl(
  ep: OAuthEndpoints,
  opts: { clientId: string; redirectUri: string; scopes: readonly string[]; state: string },
): string {
  const u = new URL(ep.authorizeUrl);
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("scope", opts.scopes.join(" "));
  u.searchParams.set("state", opts.state);
  u.searchParams.set("response_type", "code");
  return u.toString();
}

function normalizeTokenResponse(raw: unknown): TokenSet {
  const r = (raw ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (r[k] !== undefined && r[k] !== null && r[k] !== "") return r[k];
    return undefined;
  };
  const accessToken = pick("access_token", "accessToken");
  if (typeof accessToken !== "string") {
    throw new Error(`Token response has no access_token: ${JSON.stringify(raw).slice(0, 300)}`);
  }
  const refreshToken = pick("refresh_token", "refreshToken");
  const expiresInRaw = pick("expires_in", "expiresIn");
  const expiresIn = typeof expiresInRaw === "number" ? expiresInRaw : typeof expiresInRaw === "string" ? Number(expiresInRaw) : undefined;
  const scope = pick("scope", "scopes");
  return {
    accessToken,
    refreshToken: typeof refreshToken === "string" ? refreshToken : undefined,
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : undefined,
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + (expiresIn as number) * 1000 : undefined,
    scope: Array.isArray(scope) ? scope.join(" ") : typeof scope === "string" ? scope : undefined,
    raw,
  };
}

async function postForm(url: string, fields: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(fields).toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* raw */
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function exchangeCode(
  ep: OAuthEndpoints,
  opts: { clientId: string; clientSecret: string; redirectUri: string; code: string; timeoutMs?: number },
): Promise<TokenSet> {
  const { status, body } = await postForm(
    ep.tokenUrl,
    {
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      code: opts.code,
      grant_type: "authorization_code",
    },
    opts.timeoutMs ?? 30_000,
  );
  if (status < 200 || status >= 300) {
    throw new Error(`Token exchange failed: HTTP ${status} ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return normalizeTokenResponse(body);
}

/**
 * Refresh an access token. Tries the documented token endpoint with
 * grant_type=refresh_token first, then the legacy /refresh endpoint.
 * Do NOT send `scope` — Mural rejects refresh requests that include it.
 */
export async function refreshAccessToken(
  ep: OAuthEndpoints,
  opts: { clientId: string; clientSecret: string; refreshToken: string; timeoutMs?: number },
): Promise<TokenSet> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const attempts: Array<{ url: string; fields: Record<string, string> }> = [
    {
      url: ep.tokenUrl,
      fields: {
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        refresh_token: opts.refreshToken,
        grant_type: "refresh_token",
      },
    },
    {
      url: ep.refreshUrl,
      fields: {
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        refreshToken: opts.refreshToken,
        grant_type: "refresh_token",
      },
    },
  ];
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      const { status, body } = await postForm(a.url, a.fields, timeoutMs);
      if (status >= 200 && status < 300) return normalizeTokenResponse(body);
      errors.push(`${a.url} -> HTTP ${status} ${typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`);
      if (status === 401 || status === 403) break; // credentials are wrong; the other URL won't help
    } catch (err) {
      errors.push(`${a.url} -> ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`Token refresh failed:\n  ${errors.join("\n  ")}`);
}

// ---- .env persistence -------------------------------------------------------

/** Upsert KEY=value lines in a dotenv file, preserving everything else. */
export function upsertEnvFile(path: string, values: Record<string, string | undefined>): void {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing.length ? existing.split(/\r?\n/) : [];
  const pending = new Map(Object.entries(values).filter(([, v]) => v !== undefined) as Array<[string, string]>);

  const out = lines.map((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m || !pending.has(m[1])) return line;
    const v = pending.get(m[1])!;
    pending.delete(m[1]);
    return `${m[1]}=${quoteEnv(v)}`;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of pending) out.push(`${k}=${quoteEnv(v)}`);
  writeFileSync(path, out.join("\n") + "\n", { mode: 0o600 });
}

function quoteEnv(v: string): string {
  return /^[A-Za-z0-9_./:+=-]*$/.test(v) ? v : JSON.stringify(v);
}
