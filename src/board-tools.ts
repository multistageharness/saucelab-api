/**
 * Board-level and asset tools: rooms/murals navigation, mural create/duplicate/
 * rename, PDF export, snapshot (thumbnail as image), tags, images (upload
 * round-trip), files, comments, get-widget, and batch drawing.
 * Request shapes follow the live API validator (see README, "Live API behaviour").
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MuralApiError, type MuralClient } from "./mural-client.js";
import { renderMural } from "./render.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };
const ok = (data: unknown, summary: string): ToolResult => ({ content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }] });
const fail = (err: unknown): ToolResult => {
  const msg = err instanceof Error ? err.message : String(err);
  const body = err instanceof MuralApiError && err.body !== undefined ? `\n\nResponse body:\n${typeof err.body === "string" ? err.body : JSON.stringify(err.body, null, 2)}` : "";
  return { content: [{ type: "text", text: msg + body }], isError: true };
};
const strip = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
const muralId = z.string().min(1).describe('Mural (board) id, e.g. "workspace.1234567890".');
const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"] as const;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", pdf: "application/pdf" };

async function fetchBytes(url: string, timeoutMs: number): Promise<{ bytes: Buffer; contentType: string }> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "" };
  } finally { clearTimeout(t); }
}

export function registerBoardTools(server: McpServer, client: MuralClient, timeoutMs: number): void {
  // ---- navigation ---------------------------------------------------------
  server.registerTool("mural_list_rooms", {
    title: "List rooms", description: "Lists rooms in a workspace. Murals live in rooms; you need a roomId to create a mural.",
    inputSchema: { workspaceId: z.string().min(1), limit: z.number().int().min(1).max(100).optional(), next: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ workspaceId, limit, next }) => { try { const r = await client.listRooms(workspaceId, { limit, next }); return ok(r, `${r.value?.length ?? 0} room(s)`); } catch (e) { return fail(e); } });

  server.registerTool("mural_list_murals", {
    title: "List murals", description: "Lists murals (boards) in a workspace or, if roomId is given, in that room.",
    inputSchema: { workspaceId: z.string().min(1).optional(), roomId: z.union([z.number(), z.string()]).optional(), limit: z.number().int().min(1).max(100).optional(), next: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ workspaceId, roomId, limit, next }) => {
    try {
      if (!workspaceId && roomId === undefined) return { content: [{ type: "text", text: "Pass workspaceId or roomId." }], isError: true };
      const r = roomId !== undefined ? await client.listRoomMurals(String(roomId), { limit, next }) : await client.listWorkspaceMurals(workspaceId!, { limit, next });
      const rows = (r.value ?? []).map((m) => ({ id: m.id, title: m.title, roomId: m.roomId, workspaceId: m.workspaceId, updatedOn: m.updatedOn }));
      return ok({ value: rows, next: r.next }, `${rows.length} mural(s)`);
    } catch (e) { return fail(e); }
  });

  // ---- mural lifecycle ----------------------------------------------------
  server.registerTool("mural_create_board", {
    title: "Create mural", description: "Creates a new empty mural (board) in a room. Returns its id for subsequent drawing tools.",
    inputSchema: { roomId: z.union([z.number(), z.string()]).describe("Numeric room id from mural_list_rooms."), title: z.string().min(1), width: z.number().positive().optional(), height: z.number().positive().optional(), infinite: z.boolean().optional().describe("Infinite canvas instead of fixed size."), backgroundColor: z.string().optional().describe("#RRGGBBAA") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ roomId, ...rest }) => { try { const m = await client.createMural(strip({ roomId: Number(roomId), ...rest })); return ok(m, `Created mural ${m.id} "${m.title ?? rest.title}"`); } catch (e) { return fail(e); } });

  server.registerTool("mural_duplicate_board", {
    title: "Duplicate mural", description: "Duplicates a mural into a room with a new title (useful to work on a copy).",
    inputSchema: { muralId, roomId: z.union([z.number(), z.string()]), title: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ muralId: id, roomId, title }) => { try { const m = await client.duplicateMural(id, { roomId: Number(roomId), title }); return ok(m, `Duplicated to ${m.id}`); } catch (e) { return fail(e); } });

  server.registerTool("mural_update_board", {
    title: "Update mural", description: "Renames a mural or changes its size/background.",
    inputSchema: { muralId, title: z.string().optional(), width: z.number().positive().optional(), height: z.number().positive().optional(), backgroundColor: z.string().optional().describe("#RRGGBBAA"), infinite: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ muralId: id, ...patch }) => { try { const p = strip(patch); if (!Object.keys(p).length) return { content: [{ type: "text", text: "Nothing to update." }], isError: true }; const m = await client.updateMural(id, p); return ok(m, `Updated mural ${id}`); } catch (e) { return fail(e); } });

  // ---- look at the drawing ------------------------------------------------
  server.registerTool("mural_snapshot", {
    title: "Snapshot (current PNG)", description:
      "Returns a PNG rendering of the board AS IT IS NOW: exports the mural to PDF (always current) and rasterizes it locally (sips on macOS, pdftoppm on Linux). " +
      "Takes 5-30 s. `maxPx` bounds the longest side (default 1600; 0 = native resolution, large). " +
      "If no rasterizer is available, returns the PDF URL plus Mural's cached thumbnail, which is explicitly marked STALE (Mural refreshes it rarely). " +
      "Set `source: \"thumbnail\"` to skip the export and get the cached thumbnail quickly.",
    inputSchema: { muralId, maxPx: z.number().int().min(0).max(8000).default(1600), source: z.enum(["render", "thumbnail"]).default("render"), waitSeconds: z.number().int().min(5).max(180).default(90) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ muralId: id, maxPx, source, waitSeconds }) => {
    try {
      const m = await client.getMural(id);
      const thumb = async (reason: string): Promise<ToolResult> => {
        const url = m.thumbnailUrl as string | undefined;
        if (!url) return { content: [{ type: "text", text: `${reason} No thumbnail available either.` }], isError: true };
        const { bytes, contentType } = await fetchBytes(url, timeoutMs);
        return { content: [{ type: "text", text: `${reason}\nSTALE IMAGE: this is Mural's cached thumbnail of "${m.title}" (${bytes.length} bytes); it is refreshed rarely and may not reflect recent edits. Use source="render" for the current state.` }, { type: "image", data: bytes.toString("base64"), mimeType: contentType.startsWith("image/") ? contentType : "image/png" }] };
      };
      if (source === "thumbnail") return thumb("Cached thumbnail requested.");
      const r = await renderMural(client, id, { maxPx, waitMs: waitSeconds * 1000 });
      if (!r.png) return thumb(`${r.warning} PDF (current): ${r.pdfUrl}`);
      return { content: [
        { type: "text", text: `Current render of "${m.title}" (board ${m.width}x${m.height}px) — ${r.width}x${r.height}px PNG via ${r.renderer}, ${Math.round(r.png.length / 1024)} KB. Full-resolution PDF (time-limited): ${r.pdfUrl}` },
        { type: "image", data: r.png.toString("base64"), mimeType: "image/png" } ] };
    } catch (e) { return fail(e); }
  });

  server.registerTool("mural_export_pdf", {
    title: "Export PDF", description: "Exports the mural as a PDF (the only format the API offers). Starts the export, polls until ready (up to ~60s) and returns a time-limited download URL.",
    inputSchema: { muralId, waitSeconds: z.number().int().min(0).max(120).default(60) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ muralId: id, waitSeconds }) => {
    try {
      const { exportId } = await client.startExport(id, "pdf");
      const deadline = Date.now() + waitSeconds * 1000; let status: Record<string, unknown> = {};
      while (Date.now() < deadline) {
        try { status = await client.getExport(id, exportId); if (status.url) break; }
        catch (e) { if (!(e instanceof MuralApiError && e.status === 404)) throw e; status = { state: "processing" }; } // 404 EXPORT_NOT_FOUND = still rendering
        await new Promise((r) => setTimeout(r, 3000));
      }
      return status.url ? ok(status, `PDF ready: ${status.url}`) : ok({ exportId, ...status }, `Export ${exportId} still processing; call again with the same muralId later or poll GET /murals/{id}/exports/${exportId}`);
    } catch (e) { return fail(e); }
  });

  // ---- tags ---------------------------------------------------------------
  server.registerTool("mural_list_tags", { title: "List tags", description: "Lists the tags defined on a mural (sticky notes can carry tag ids via mural_update_widget `extra: { tags: [...] }`).", inputSchema: { muralId }, annotations: { readOnlyHint: true, openWorldHint: true } },
    async ({ muralId: id }) => { try { const r = await client.listTags(id); return ok(r, `${r.value?.length ?? 0} tag(s)`); } catch (e) { return fail(e); } });
  server.registerTool("mural_create_tag", { title: "Create tag", description: "Creates a tag on a mural.", inputSchema: { muralId, text: z.string().min(1), backgroundColor: z.string().optional().describe("#RRGGBBAA"), borderColor: z.string().optional(), color: z.string().optional().describe("Text colour #RRGGBBAA") }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
    async ({ muralId: id, ...body }) => { try { const r = await client.createTag(id, strip(body)); return ok(r, `Created tag "${body.text}"`); } catch (e) { return fail(e); } });

  // ---- widgets: get / image / file / comment -----------------------------
  server.registerTool("mural_get_widget", { title: "Get widget", description: "Fetches one widget with all its properties (type, geometry, style, text, parent).", inputSchema: { muralId, widgetId: z.string().min(1) }, annotations: { readOnlyHint: true, openWorldHint: true } },
    async ({ muralId: id, widgetId }) => { try { const w = await client.getWidget(id, widgetId); return ok(w, `${w.type} ${w.id}`); } catch (e) { return fail(e); } });

  server.registerTool("mural_create_image", {
    title: "Create image", description:
      "Places an image on the board. Provide either `url` (fetched server-side) or `base64` data. The image is uploaded to Mural's asset store first, then the widget is created. Allowed formats: png, jpg, jpeg, gif, webp, bmp, ico.",
    inputSchema: { muralId, x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(), url: z.string().url().optional(), base64: z.string().optional().describe("Raw base64 (no data: prefix)."), extension: z.enum(IMAGE_EXT).optional().describe("Required with base64; inferred from url otherwise."), caption: z.string().optional(), showCaption: z.boolean().optional(), border: z.boolean().optional(), hyperlink: z.string().url().optional(), rotation: z.number().optional(), parentId: z.string().optional(), stackingOrder: z.number().int().optional(), title: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ muralId: id, url, base64, extension, ...rest }) => {
    try {
      let bytes: Buffer; let ext = extension as string | undefined;
      if (url) { const got = await fetchBytes(url, timeoutMs); bytes = got.bytes; ext ??= (new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1] ?? got.contentType.split("/")[1]?.replace("jpeg", "jpg"))?.toLowerCase(); }
      else if (base64) { bytes = Buffer.from(base64, "base64"); }
      else return { content: [{ type: "text", text: "Pass url or base64." }], isError: true };
      if (!ext || !(IMAGE_EXT as readonly string[]).includes(ext)) return { content: [{ type: "text", text: `Unsupported or unknown image extension "${ext}". Allowed: ${IMAGE_EXT.join(", ")}.` }], isError: true };
      const name = await client.uploadAsset(id, ext, bytes, MIME[ext] ?? "application/octet-stream");
      const w = await client.createWidget(id, "image", strip({ name, ...rest }));
      return ok(w, `Created image ${(w as { id?: string }).id ?? ""} (${bytes.length} bytes uploaded as ${ext})`);
    } catch (e) { return fail(e); }
  });

  server.registerTool("mural_create_file", {
    title: "Attach file", description: "Uploads a file (e.g. PDF) from a URL and places it as a file widget.",
    inputSchema: { muralId, x: z.number(), y: z.number(), url: z.string().url(), extension: z.string().optional().describe("Inferred from the URL if omitted."), width: z.number().positive().optional(), height: z.number().positive().optional(), title: z.string().optional(), parentId: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ muralId: id, url, extension, ...rest }) => {
    try {
      const got = await fetchBytes(url, timeoutMs); const ext = (extension ?? new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1] ?? "bin").toLowerCase();
      const name = await client.uploadAsset(id, ext, got.bytes, got.contentType || MIME[ext] || "application/octet-stream");
      const w = await client.createWidget(id, "file", strip({ name, ...rest }));
      return ok(w, `Attached file ${(w as { id?: string }).id ?? ""} (${got.bytes.length} bytes)`);
    } catch (e) { return fail(e); }
  });

  server.registerTool("mural_create_comment", {
    title: "Create comment", description: "Pins a comment at a canvas position.",
    inputSchema: { muralId, x: z.number(), y: z.number(), message: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ muralId: id, ...body }) => { try { const w = await client.createWidget(id, "comment", body); return ok(w, `Created comment ${(w as { id?: string }).id ?? ""}`); } catch (e) { return fail(e); } });
}
