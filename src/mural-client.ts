import type { MuralConfig } from "./config.js";
import { refreshAccessToken } from "./oauth.js";

/** Refresh this many ms before the recorded expiry. */
const EXPIRY_SKEW_MS = 60_000;

export class MuralApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "MuralApiError";
  }
}

export interface Paged<T> {
  value: T[];
  next?: string;
}

export interface Widget {
  id: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export interface Mural {
  id: string;
  title?: string;
  width?: number;
  height?: number;
  workspaceId?: string;
  roomId?: string;
  [key: string]: unknown;
}

export interface Workspace {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export type StickyNoteShape = "rectangle" | "circle";

export interface StickyNoteStyle {
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  font?: string;
  fontSize?: number;
  textAlign?: "left" | "center" | "right";
  border?: boolean;
}

export interface CreateStickyNoteInput {
  x: number;
  y: number;
  shape: StickyNoteShape;
  text?: string;
  htmlText?: string;
  width?: number;
  height?: number;
  title?: string;
  style?: StickyNoteStyle;
}

export type UpdateWidgetInput = Record<string, unknown>;

/**
 * Widget `type` as returned by GET /murals/{id}/widgets  ->  path segment used by
 * PATCH /murals/{id}/widgets/{segment}/{widgetId}.
 * Unknown types fall through to a slugified form of the type string.
 */
const WIDGET_TYPE_TO_PATH: Record<string, string> = {
  "sticky note": "sticky-note",
  "sticky-note": "sticky-note",
  stickynote: "sticky-note",
  text: "textbox",
  textbox: "textbox",
  "text box": "textbox",
  shape: "shape",
  title: "title",
  arrow: "arrow",
  area: "area",
  image: "image",
  file: "file",
  table: "table",
  comment: "comment",
  "comment thread": "comment",
};

/** GET /widgets?type= accepts plural names. Map singular / path forms to them. */
const FILTER_TYPE_ALIASES: Record<string, string> = {
  "sticky note": "sticky notes",
  "sticky-note": "sticky notes",
  stickynote: "sticky notes",
  text: "texts",
  textbox: "texts",
  "text box": "texts",
  shape: "shapes",
  arrow: "arrows",
  area: "areas",
  image: "images",
  file: "files",
  table: "tables",
  comment: "comments",
  icon: "icons",
  title: "titles",
};

export function normalizeFilterType(filter: string): string {
  return filter
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .map((t) => FILTER_TYPE_ALIASES[t] ?? t)
    .join(",");
}

export function widgetTypeToPathSegment(type: string): string {
  const key = type.trim().toLowerCase();
  return WIDGET_TYPE_TO_PATH[key] ?? key.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export class MuralClient {
  private accessToken: string;
  private refreshToken?: string;
  private expiresAt?: number;
  private refreshing?: Promise<void>;

  constructor(private readonly cfg: MuralConfig) {
    this.accessToken = cfg.accessToken;
    this.refreshToken = cfg.refreshToken;
    this.expiresAt = cfg.tokenExpiresAt;
  }

  get canRefresh(): boolean {
    return Boolean(this.refreshToken && this.cfg.clientId && this.cfg.clientSecret);
  }

  /** Refresh the access token (single-flight). Throws if refresh is not possible. */
  async refresh(reason: string): Promise<void> {
    if (!this.canRefresh) {
      throw new MuralApiError(
        `Access token ${reason} and no refresh is possible (need MURAL_REFRESH_TOKEN + MURAL_CLIENT_ID + MURAL_CLIENT_SECRET). Run \`npm run auth\`.`,
        401,
        "POST",
        "/authorization/oauth2/token",
        undefined,
      );
    }
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const t = await refreshAccessToken(this.cfg.oauth, {
          clientId: this.cfg.clientId!,
          clientSecret: this.cfg.clientSecret!,
          refreshToken: this.refreshToken!,
          timeoutMs: this.cfg.requestTimeoutMs,
        });
        this.accessToken = t.accessToken;
        if (t.refreshToken) this.refreshToken = t.refreshToken;
        this.expiresAt = t.expiresAt;
        console.error(
          `[mural] access token refreshed (${reason})` +
            (t.expiresAt ? `; expires ${new Date(t.expiresAt).toISOString()}` : ""),
        );
        if (this.cfg.persistTokens) {
          const store = this.cfg.secrets.backend === "keychain" ? `keychain service "${this.cfg.secrets.service}"` : this.cfg.secrets.envTarget;
          try {
            await this.cfg.secrets.persist({
              MURAL_ACCESS_TOKEN: this.accessToken,
              MURAL_REFRESH_TOKEN: this.refreshToken,
              MURAL_TOKEN_EXPIRES_AT: this.expiresAt ? String(this.expiresAt) : undefined,
            });
          } catch (err) {
            console.error(`[mural] could not persist refreshed token to ${store}: ${err instanceof Error ? err.message : err}`);
          }
        }
      })().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  private async ensureFreshToken(): Promise<void> {
    if (!this.accessToken) return this.refresh("missing");
    if (this.expiresAt !== undefined && Date.now() >= this.expiresAt - EXPIRY_SKEW_MS && this.canRefresh) {
      return this.refresh("expired");
    }
  }

  // ---- Workspaces -------------------------------------------------------

  listWorkspaces(opts: { limit?: number; next?: string } = {}): Promise<Paged<Workspace>> {
    return this.request<Paged<Workspace>>("GET", "/workspaces", { query: opts });
  }

  // ---- Murals (boards) --------------------------------------------------

  async getMural(muralId: string): Promise<Mural> {
    return unwrap<Mural>(await this.request<unknown>("GET", `/murals/${enc(muralId)}`));
  }

  // ---- Widgets ----------------------------------------------------------

  listWidgets(
    muralId: string,
    opts: { limit?: number; next?: string; type?: string; parentId?: string } = {},
  ): Promise<Paged<Widget>> {
    return this.request<Paged<Widget>>("GET", `/murals/${enc(muralId)}/widgets`, {
      query: { ...opts, type: opts.type ? normalizeFilterType(opts.type) : undefined },
    });
  }

  /** Walk every page. `maxPages` guards against runaway boards. */
  async listAllWidgets(
    muralId: string,
    opts: { type?: string; parentId?: string; pageSize?: number; maxPages?: number } = {},
  ): Promise<{ widgets: Widget[]; truncated: boolean; next?: string }> {
    const widgets: Widget[] = [];
    const maxPages = opts.maxPages ?? 50;
    let next: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.listWidgets(muralId, {
        limit: opts.pageSize ?? 100,
        next,
        type: opts.type,
        parentId: opts.parentId,
      });
      widgets.push(...(res.value ?? []));
      next = res.next || undefined;
      if (!next) return { widgets, truncated: false };
    }
    return { widgets, truncated: true, next };
  }

  async getWidget(muralId: string, widgetId: string): Promise<Widget> {
    return unwrap<Widget>(await this.request<unknown>("GET", `/murals/${enc(muralId)}/widgets/${enc(widgetId)}`));
  }

  async createStickyNotes(muralId: string, notes: CreateStickyNoteInput[]): Promise<Paged<Widget>> {
    return this.request<Paged<Widget>>("POST", `/murals/${enc(muralId)}/widgets/sticky-note`, {
      body: notes,
    });
  }

  /** POST an array body (sticky-note, shape, textbox, title, area). */
  createWidgets(muralId: string, typeSegment: string, items: unknown[]): Promise<Paged<Widget>> {
    return this.request<Paged<Widget>>("POST", `/murals/${enc(muralId)}/widgets/${typeSegment}`, { body: items });
  }

  /** POST a single-object body (arrow, table, image, file, comment). */
  async createWidget(muralId: string, typeSegment: string, item: unknown): Promise<unknown> {
    return unwrap<unknown>(await this.request<unknown>("POST", `/murals/${enc(muralId)}/widgets/${typeSegment}`, { body: item }));
  }

  // ---- rooms / murals ---------------------------------------------------

  listRooms(workspaceId: string, opts: { limit?: number; next?: string } = {}): Promise<Paged<Record<string, unknown>>> {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/rooms`, { query: opts });
  }
  listWorkspaceMurals(workspaceId: string, opts: { limit?: number; next?: string } = {}): Promise<Paged<Mural>> {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/murals`, { query: opts });
  }
  listRoomMurals(roomId: string, opts: { limit?: number; next?: string } = {}): Promise<Paged<Mural>> {
    return this.request("GET", `/rooms/${enc(roomId)}/murals`, { query: opts });
  }
  async createMural(body: Record<string, unknown>): Promise<Mural> {
    return unwrap<Mural>(await this.request<unknown>("POST", "/murals", { body }));
  }
  async duplicateMural(muralId: string, body: { roomId: number; title: string }): Promise<Mural> {
    return unwrap<Mural>(await this.request<unknown>("POST", `/murals/${enc(muralId)}/duplicate`, { body }));
  }
  async updateMural(muralId: string, body: Record<string, unknown>): Promise<Mural> {
    return unwrap<Mural>(await this.request<unknown>("PATCH", `/murals/${enc(muralId)}`, { body }));
  }
  async startExport(muralId: string, downloadFormat: "pdf"): Promise<{ exportId: string }> {
    return unwrap<{ exportId: string }>(await this.request<unknown>("POST", `/murals/${enc(muralId)}/export`, { body: { downloadFormat } }));
  }
  async getExport(muralId: string, exportId: string): Promise<Record<string, unknown>> {
    return unwrap<Record<string, unknown>>(await this.request<unknown>("GET", `/murals/${enc(muralId)}/exports/${enc(exportId)}`));
  }
  listTags(muralId: string): Promise<Paged<Record<string, unknown>>> {
    return this.request("GET", `/murals/${enc(muralId)}/tags`);
  }
  async createTag(muralId: string, body: Record<string, unknown>): Promise<unknown> {
    return unwrap<unknown>(await this.request<unknown>("POST", `/murals/${enc(muralId)}/tags`, { body }));
  }

  /** Asset upload round-trip: POST /assets -> presigned PUT -> returns the asset `name` for image/file widgets. */
  async uploadAsset(muralId: string, fileExtension: string, bytes: Buffer, contentType: string): Promise<string> {
    const asset = unwrap<{ name: string; url: string; headers?: Record<string, string> }>(
      await this.request<unknown>("POST", `/murals/${enc(muralId)}/assets`, { body: { fileExtension } }),
    );
    const res = await fetch(asset.url, { method: "PUT", headers: { "Content-Type": contentType, ...(asset.headers ?? {}) }, body: new Uint8Array(bytes) });
    if (!res.ok) throw new MuralApiError(`asset upload PUT -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status, "PUT", "<asset upload url>", undefined);
    return asset.name;
  }

  async deleteWidget(muralId: string, widgetId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/murals/${enc(muralId)}/widgets/${enc(widgetId)}`);
  }

  async updateWidget(
    muralId: string,
    widgetId: string,
    patch: UpdateWidgetInput,
    widgetType?: string,
  ): Promise<{ widget: unknown; resolvedType: string }> {
    let type = widgetType;
    if (!type) {
      const current = await this.getWidget(muralId, widgetId);
      type = current.type;
      if (!type) {
        throw new Error(`Widget ${widgetId} has no "type" field; pass widgetType explicitly.`);
      }
    }
    const segment = widgetTypeToPathSegment(type);
    const widget = unwrap<unknown>(
      await this.request<unknown>("PATCH", `/murals/${enc(muralId)}/widgets/${segment}/${enc(widgetId)}`, {
        body: patch,
      }),
    );
    return { widget, resolvedType: segment };
  }

  // ---- HTTP core --------------------------------------------------------

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    await this.ensureFreshToken();
    try {
      return await this.rawRequest<T>(method, path, opts);
    } catch (err) {
      if (err instanceof MuralApiError && err.status === 401 && this.canRefresh) {
        await this.refresh("rejected with 401");
        return this.rawRequest<T>(method, path, opts);
      }
      throw err;
    }
  }

  private async rawRequest<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(this.cfg.apiBaseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new MuralApiError(`${method} ${path} failed: ${reason}`, 0, method, path, undefined);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
    }

    if (!res.ok) {
      const detail =
        parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : text.slice(0, 500);
      const hint =
        res.status === 401
          ? " (401: access token is invalid or expired; set MURAL_REFRESH_TOKEN + client id/secret or run `npm run auth`)"
          : res.status === 403
            ? " (403: token lacks scope, or the workspace has not enabled API access)"
            : res.status === 404
              ? " (404: check the mural/widget id; mural ids look like <workspace>.<id>)"
              : "";
      throw new MuralApiError(
        `${method} ${path} -> HTTP ${res.status}${hint}${detail ? `: ${detail}` : ""}`,
        res.status,
        method,
        path,
        parsed,
      );
    }
    return parsed as T;
  }
}

/**
 * The live API wraps single objects as `{ value: {...} }` (lists as `{ value: [...] }`).
 * Accept both wrapped and bare shapes.
 */
function unwrap<T>(res: unknown): T {
  if (res && typeof res === "object" && "value" in res) {
    const v = (res as { value: unknown }).value;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as T;
  }
  return res as T;
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
