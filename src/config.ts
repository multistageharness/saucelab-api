import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { loadSecrets, type SecretsInfo } from "./secrets.js";

export interface MuralConfig {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires, if known. */
  tokenExpiresAt?: number;
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  apiBaseUrl: string;
  oauth: { authorizeUrl: string; tokenUrl: string; refreshUrl: string };
  requestTimeoutMs: number;
  /** The .env file that was loaded, if any. */
  envFile?: string;
  /** Where secrets came from and where refreshed tokens are written back (keychain or .env). */
  secrets: SecretsInfo;
  /** Persist refreshed tokens through `secrets`. Default true when a .env was loaded or the keychain is active. */
  persistTokens: boolean;
}

export const DEFAULT_API_BASE_URL = "https://app.mural.co/api/public/v1";
export const DEFAULT_REDIRECT_URI = "http://localhost:50000/callback";
/** Default OAuth scopes requested by `npm run auth`. Override per integration with MURAL_SCOPES. */
export const REQUIRED_SCOPES = [
  "murals:read",
  "murals:write",
  "workspaces:read",
  "rooms:read",
  "rooms:write",
] as const;

/** Scopes in effect: MURAL_SCOPES (space- or comma-separated) when set, else REQUIRED_SCOPES. */
export function configuredScopes(): string[] {
  const raw = process.env.MURAL_SCOPES?.trim();
  return raw ? raw.split(/[\s,]+/).filter(Boolean) : [...REQUIRED_SCOPES];
}

/**
 * Candidate .env locations, in priority order:
 *   1. MURAL_ENV_FILE (explicit path, absolute or relative to cwd)
 *   2. <package root>/.env   (relative to the compiled build/index.js -> ../.env)
 *   3. <cwd>/.env
 *
 * The package-root location is the one MCP hosts rely on: they launch
 * `node /path/to/mcp-mural/build/index.js` from an arbitrary cwd, so the file
 * next to package.json is what "relative .env" has to mean.
 */
export function envFileCandidates(): string[] {
  // An explicit MURAL_ENV_FILE is exclusive: no silent fallback to another file.
  if (process.env.MURAL_ENV_FILE) return [resolve(process.env.MURAL_ENV_FILE)];
  const here = dirname(fileURLToPath(import.meta.url)); // build/ (or src/ under ts runners)
  const packageRoot = resolve(here, "..");
  return [...new Set([resolve(packageRoot, ".env"), resolve(process.cwd(), ".env")])];
}

/** Load the first .env that exists. Existing process.env values always win. */
export function loadEnvFile(): string | undefined {
  for (const candidate of envFileCandidates()) {
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, override: false, quiet: true });
      return candidate;
    }
  }
  return undefined;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve configuration: process env, then .env, then the secret store (see secrets.ts).
 * Async because the keychain is read through child processes.
 */
export async function loadConfig(): Promise<MuralConfig> {
  const envFile = loadEnvFile();
  const secrets = await loadSecrets({ envFile });

  // A keychain:// reference that is still literal was never resolved: the keychain backend is off.
  const unresolved = Object.entries(process.env)
    .filter(([k, v]) => k.startsWith("MURAL_") && typeof v === "string" && v.startsWith("keychain://"))
    .map(([k]) => k);
  if (unresolved.length) {
    throw new Error(
      `${unresolved.join(", ")} hold keychain:// references but the keychain backend is not active (backend=${secrets.backend}). ` +
        "Set MURAL_SECRETS_BACKEND=keychain and run `make vendor`, or put plain values in .env.",
    );
  }

  const accessToken = (process.env.MURAL_ACCESS_TOKEN ?? "").trim();
  const refreshToken = process.env.MURAL_REFRESH_TOKEN?.trim() || undefined;
  const clientId = process.env.MURAL_CLIENT_ID?.trim() || undefined;
  const clientSecret = process.env.MURAL_CLIENT_SECRET?.trim() || undefined;
  const canRefresh = Boolean(refreshToken && clientId && clientSecret);

  if (!accessToken && !canRefresh) {
    const looked = envFileCandidates().join("\n  ");
    const hint =
      secrets.backend === "keychain"
        ? `Keychain service "${secrets.service}" holds no MURAL_ACCESS_TOKEN and no refresh credentials. Run \`make auth\`, or store values with \`make secret KEY=<name>\`.`
        : "Run `npm run auth` to authorize, or set it in the environment / a .env file.";
    throw new Error(
      `MURAL_ACCESS_TOKEN is not set (and no MURAL_REFRESH_TOKEN + client id/secret to mint one).\n${hint}\n` +
        `.env locations checked:\n  ${looked}\nSee .env.example for the expected keys.`,
    );
  }

  const apiBaseUrl = (process.env.MURAL_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  const expiresRaw = process.env.MURAL_TOKEN_EXPIRES_AT?.trim();
  const tokenExpiresAt = expiresRaw && /^\d+$/.test(expiresRaw) ? Number(expiresRaw) : undefined;
  const persistRaw = process.env.MURAL_PERSIST_TOKENS?.trim().toLowerCase();

  return {
    accessToken,
    refreshToken,
    tokenExpiresAt,
    clientId,
    clientSecret,
    redirectUri: process.env.MURAL_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI,
    apiBaseUrl,
    oauth: {
      authorizeUrl: process.env.MURAL_OAUTH_AUTHORIZE_URL?.trim() || `${apiBaseUrl}/authorization/oauth2/`,
      tokenUrl: process.env.MURAL_OAUTH_TOKEN_URL?.trim() || `${apiBaseUrl}/authorization/oauth2/token`,
      refreshUrl: process.env.MURAL_OAUTH_REFRESH_URL?.trim() || `${apiBaseUrl}/authorization/oauth2/refresh`,
    },
    requestTimeoutMs: readInt("MURAL_REQUEST_TIMEOUT_MS", 30_000),
    envFile,
    secrets,
    persistTokens: persistRaw ? !["0", "false", "no", "off"].includes(persistRaw) : Boolean(envFile) || secrets.backend === "keychain",
  };
}
