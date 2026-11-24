/**
 * Secret sources for the server (`loadConfig`) and the auth helper (`npm run auth`).
 *
 * Values are layered; a value already present always wins:
 *   1. process environment            — CI, or an MCP host's `env` block
 *   2. .env file                      — dotenv, loaded by config.ts (see its lookup order)
 *   3. macOS login keychain           — through the vendored macos-keychain-env package
 *                                        (vendors/macos-keychain-env; `make vendor` fetches it)
 *
 * MURAL_SECRETS_BACKEND chooses the store that fills the gaps and receives refreshed tokens:
 *   auto      (default) keychain when running on macOS and the module is present, else env
 *   keychain  require the keychain; fail at startup if the module is missing
 *   env       never touch the keychain (tests, CI, Linux)
 *
 * Keychain items are generic passwords: service = MURAL_KEYCHAIN_SERVICE (default
 * "mural-mcp"), account = the variable name. `make secret KEY=MURAL_CLIENT_ID` stores one
 * through a hidden prompt. Nothing in this module prints or logs a secret value.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { upsertEnvFile } from "./oauth.js";

export type SecretsBackend = "keychain" | "env";

/** Variables looked up in the keychain (account = name). All optional here; config.ts validates. */
export const KEYCHAIN_KEYS = [
  "MURAL_CLIENT_ID",
  "MURAL_CLIENT_SECRET",
  "MURAL_ACCESS_TOKEN",
  "MURAL_REFRESH_TOKEN",
  "MURAL_TOKEN_EXPIRES_AT",
  "MURAL_HTTP_SECRET",
  "MURAL_HTTP_BEARER",
] as const;

export const DEFAULT_KEYCHAIN_SERVICE = "mural-mcp";
export const VENDORED_MODULE_RELATIVE = "vendors/macos-keychain-env/src/index.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The slice of macos-keychain-env this server uses (full API: vendors/macos-keychain-env/index.d.ts). */
interface KeychainEnvModule {
  loadEnv(opts: {
    entries: Record<string, { service: string; account: string; optional?: boolean }>;
    service?: string;
    manifest?: string | false;
    override?: boolean;
    cwd?: string;
    timeoutMs?: number;
  }): Promise<{ loaded: string[]; skipped: string[]; missing: string[] }>;
  setSecret(ref: { service: string; account: string }, value: string, opts?: { label?: string }): Promise<void>;
}

export interface SecretsInfo {
  backend: SecretsBackend;
  /** Keychain service in use (keychain backend only). */
  service?: string;
  /** Module the keychain is read through (keychain backend only). */
  modulePath?: string;
  /** The .env file that was loaded, if any. */
  envFile?: string;
  /** Where env-mode writes go (also kept in step in keychain mode for keys it already defines). */
  envTarget: string;
  /** Variable names filled from the keychain. Names only, never values. */
  loaded: string[];
  /** Write values to the active store (create or update). Undefined values are skipped. */
  persist(values: Record<string, string | undefined>): Promise<void>;
}

export interface LoadSecretsOptions {
  /** The .env file config.ts loaded, if any. */
  envFile?: string;
  /** Where env-mode writes go. Default: `envFile`, else <package root>/.env. */
  envTarget?: string;
}

function requestedBackend(): "auto" | SecretsBackend {
  const raw = process.env.MURAL_SECRETS_BACKEND?.trim().toLowerCase() || "auto";
  if (raw === "auto" || raw === "keychain" || raw === "env") return raw;
  throw new Error(`MURAL_SECRETS_BACKEND must be "auto", "keychain" or "env" (got "${raw}").`);
}

/** Candidate module files, most specific first. An explicit MURAL_KEYCHAIN_ENV_MODULE must exist. */
function candidateModules(): string[] {
  const explicit = process.env.MURAL_KEYCHAIN_ENV_MODULE?.trim();
  if (explicit) {
    const p = resolve(explicit);
    const file = p.endsWith(".js") ? p : resolve(p, "src/index.js");
    if (!existsSync(file)) throw new Error(`MURAL_KEYCHAIN_ENV_MODULE points at ${file}, which does not exist.`);
    return [file];
  }
  return [resolve(PACKAGE_ROOT, VENDORED_MODULE_RELATIVE)];
}

async function importKeychainEnv(): Promise<{ mod: KeychainEnvModule; path: string } | undefined> {
  for (const file of candidateModules()) {
    if (existsSync(file)) return { mod: (await import(pathToFileURL(file).href)) as KeychainEnvModule, path: file };
  }
  // Installed as an npm dependency instead of vendored.
  const spec = "macos-keychain-env";
  try {
    return { mod: (await import(spec)) as KeychainEnvModule, path: spec };
  } catch {
    return undefined;
  }
}

/** KEY names defined (even empty) in a dotenv file. */
function envKeysIn(file: string): Set<string> {
  const keys = new Set<string>();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/**
 * Fill process.env from the active secret store and return how to write back to it.
 * Call after the .env file has been loaded, so existing values are respected.
 */
export async function loadSecrets(opts: LoadSecretsOptions = {}): Promise<SecretsInfo> {
  const requested = requestedBackend();
  const envTarget = opts.envTarget ?? opts.envFile ?? resolve(PACKAGE_ROOT, ".env");
  const envBackend = (): SecretsInfo => ({
    backend: "env",
    envFile: opts.envFile,
    envTarget,
    loaded: [],
    persist: async (values) => {
      upsertEnvFile(envTarget, values);
    },
  });

  if (requested === "env") return envBackend();
  if (process.platform !== "darwin") {
    if (requested === "keychain") throw new Error("MURAL_SECRETS_BACKEND=keychain needs macOS (secrets are read through /usr/bin/security).");
    return envBackend();
  }
  const found = await importKeychainEnv();
  if (!found) {
    if (requested === "keychain") {
      throw new Error(
        `MURAL_SECRETS_BACKEND=keychain but macos-keychain-env was not found at ${resolve(PACKAGE_ROOT, VENDORED_MODULE_RELATIVE)}. ` +
          "Run `make vendor`, or set MURAL_KEYCHAIN_ENV_MODULE to a checkout.",
      );
    }
    return envBackend();
  }

  const service = process.env.MURAL_KEYCHAIN_SERVICE?.trim() || DEFAULT_KEYCHAIN_SERVICE;
  const entries = Object.fromEntries(KEYCHAIN_KEYS.map((name) => [name, { service, account: name, optional: true }]));
  let result: { loaded: string[] };
  try {
    // override: false — environment and .env values win. A `.env.keychain` manifest next to
    // package.json is honoured as well (it must be approved with `keychain-env trust`).
    result = await found.mod.loadEnv({ entries, service, override: false, cwd: PACKAGE_ROOT });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`keychain lookup failed (service "${service}", module ${found.path}): ${msg}`);
  }

  return {
    backend: "keychain",
    service,
    modulePath: found.path,
    envFile: opts.envFile,
    envTarget,
    loaded: result.loaded,
    persist: async (values) => {
      const pairs = Object.entries(values).filter((e): e is [string, string] => typeof e[1] === "string");
      for (const [account, value] of pairs) {
        await found.mod.setSecret({ service, account }, value, { label: `${service} ${account}` });
      }
      // A loaded .env that already defines one of these keys would shadow the keychain on the
      // next start (existing values win), so keep those lines in step. Nothing new is added.
      if (opts.envFile && existsSync(opts.envFile)) {
        const present = envKeysIn(opts.envFile);
        const subset = Object.fromEntries(pairs.filter(([k]) => present.has(k)));
        if (Object.keys(subset).length) upsertEnvFile(opts.envFile, subset);
      }
    },
  };
}
