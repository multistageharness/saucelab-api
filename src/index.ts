#!/usr/bin/env node
/**
 * Mural MCP Server — stdio / JSON-RPC 2.0 transport.
 *
 * Core tools: mural_list_workspaces, mural_get_board, mural_get_widgets,
 * mural_create_sticky_note, mural_update_widget; see TOOLS for the full registry.
 *
 * Credentials are read from the environment, falling back to a .env file next
 * to package.json (see src/config.ts).  Nothing is ever written to stdout except
 * MCP protocol frames; diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttp } from "./http.js";
import { z } from "zod";

import { loadConfig, configuredScopes, type MuralConfig } from "./config.js";
import { normalizeColor, NAMED_COLORS } from "./colors.js";
import { registerWidgetTools } from "./widgets.js";
import { anchorToTopLeft } from "./geometry.js";
import { registerBoardTools } from "./board-tools.js";
import { registerDrawTools } from "./draw-tools.js";
import {
  MuralApiError,
  MuralClient,
  type CreateStickyNoteInput,
  type StickyNoteStyle,
} from "./mural-client.js";

const SERVER_NAME = "mural";
const SERVER_VERSION = "0.1.0";

/** Tool registry — names are the public contract exposed to MCP clients. */
export const TOOLS = {
  listWorkspaces: { name: "mural_list_workspaces" },
  getBoard: { name: "mural_get_board" },
  getWidgets: { name: "mural_get_widgets" },
  createStickyNote: { name: "mural_create_sticky_note" },
  updateWidget: { name: "mural_update_widget" },
  createShape: { name: "mural_create_shape" },
  createTextbox: { name: "mural_create_textbox" },
  createTitle: { name: "mural_create_title" },
  createArrow: { name: "mural_create_arrow" },
  createArea: { name: "mural_create_area" },
  deleteWidget: { name: "mural_delete_widget" },
  createWidgetsRaw: { name: "mural_create_widgets_raw" },
  listRooms: { name: "mural_list_rooms" },
  listMurals: { name: "mural_list_murals" },
  createBoard: { name: "mural_create_board" },
  duplicateBoard: { name: "mural_duplicate_board" },
  updateBoard: { name: "mural_update_board" },
  snapshot: { name: "mural_snapshot" },
  exportPdf: { name: "mural_export_pdf" },
  listTags: { name: "mural_list_tags" },
  createTag: { name: "mural_create_tag" },
  getWidget: { name: "mural_get_widget" },
  createImage: { name: "mural_create_image" },
  createFile: { name: "mural_create_file" },
  createComment: { name: "mural_create_comment" },
  draw: { name: "mural_draw" },
  createTable: { name: "mural_create_table" },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown, summary?: string): ToolResult {
  const json = JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text: summary ? `${summary}\n\n${json}` : json }] };
}

function fail(err: unknown): ToolResult {
  const message =
    err instanceof MuralApiError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  const payload =
    err instanceof MuralApiError && err.body !== undefined
      ? `${message}\n\nResponse body:\n${typeof err.body === "string" ? err.body : JSON.stringify(err.body, null, 2)}`
      : message;
  return { content: [{ type: "text", text: payload }], isError: true };
}

function log(...args: unknown[]): void {
  // stdout is the protocol channel; only stderr is safe for diagnostics.
  console.error(`[${SERVER_NAME}]`, ...args);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const muralIdSchema = z
  .string()
  .min(1)
  .describe(
    "Mural (board) id, e.g. \"acme1234.1234567890\". Found in the board URL after /m/<workspace>/<id> or via the Mural API.",
  );

const styleSchema = z
  .object({
    backgroundColor: z
      .string()
      .optional()
      .describe(`Colour name (${NAMED_COLORS.join(", ")}) or hex #RRGGBB / #RRGGBBAA.`),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    font: z.string().optional().describe('Font family, default "proxima-nova".'),
    fontSize: z.number().int().positive().optional().describe("Font size in px, default 23."),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    border: z.boolean().optional(),
  })
  .strict();

function toApiStyle(style?: z.infer<typeof styleSchema>): StickyNoteStyle | undefined {
  if (!style) return undefined;
  const out: StickyNoteStyle = { ...style };
  if (style.backgroundColor) out.backgroundColor = normalizeColor(style.backgroundColor);
  return out;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function buildServer(cfg: MuralConfig, sharedClient?: MuralClient): McpServer {
  const client = sharedClient ?? new MuralClient(cfg);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for reading and mutating Mural boards through the Mural Public API. " +
        "Board ids look like \"<workspace>.<number>\". Coordinates are canvas pixels with the origin at the top-left. " +
        "A board open in a browser tab renders changes live.",
    },
  );

  // 1. mural_list_workspaces -----------------------------------------------
  server.registerTool(
    TOOLS.listWorkspaces.name,
    {
      title: "List Mural workspaces",
      description:
        "Queries and returns the workspaces accessible to the authenticated account. Supports pagination via limit/next.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Max results per page (default 25)."),
        next: z.string().optional().describe("Pagination token from a previous call."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit, next }) => {
      try {
        const res = await client.listWorkspaces({ limit, next });
        const count = res.value?.length ?? 0;
        return ok(res, `${count} workspace(s)${res.next ? " (more available: pass next)" : ""}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // 2. mural_get_board ----------------------------------------------------
  server.registerTool(
    TOOLS.getBoard.name,
    {
      title: "Get Mural board",
      description:
        "Fetches a mural (board): canvas dimensions, layout boundaries and metadata such as title, workspace, room, sharing settings and timestamps.",
      inputSchema: { muralId: muralIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ muralId }) => {
      try {
        const mural = await client.getMural(muralId);
        const dims =
          mural.width !== undefined && mural.height !== undefined
            ? `${mural.width}x${mural.height}px`
            : "unknown size";
        return ok(mural, `Board "${mural.title ?? mural.id}" (${dims})`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // 3. mural_get_widgets --------------------------------------------------
  server.registerTool(
    TOOLS.getWidgets.name,
    {
      title: "List board widgets",
      description:
        "Traverses and dumps the canvas elements of a mural (sticky notes, text boxes, shapes, arrows/connectors, areas, images, tables, comments). " +
        "Follows pagination automatically unless a `next` token is given.",
      inputSchema: {
        muralId: muralIdSchema,
        type: z
          .string()
          .optional()
          .describe(
            'Optional comma-separated widget type filter. Accepts "sticky note"/"sticky notes", "text", "shape", "arrow", "area", "image", "file", "table", "comment", "icon", "title" (normalised to the API\'s plural form).',
          ),
        parentId: z.string().optional().describe("Only widgets inside this parent (e.g. an area) are returned."),
        limit: z.number().int().min(1).max(100).optional().describe("Page size (default 100)."),
        next: z
          .string()
          .optional()
          .describe("Pagination token. When set, only that single page is returned instead of walking all pages."),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Safety cap on pages walked when auto-paginating (default 50)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ muralId, type, parentId, limit, next, maxPages }) => {
      try {
        if (next) {
          const page = await client.listWidgets(muralId, { limit, next, type, parentId });
          return ok(page, `${page.value?.length ?? 0} widget(s) on this page`);
        }
        const { widgets, truncated, next: more } = await client.listAllWidgets(muralId, {
          type,
          parentId,
          pageSize: limit,
          maxPages,
        });
        const byType = widgets.reduce<Record<string, number>>((acc, w) => {
          acc[w.type ?? "unknown"] = (acc[w.type ?? "unknown"] ?? 0) + 1;
          return acc;
        }, {});
        const summary =
          `${widgets.length} widget(s)` +
          (Object.keys(byType).length ? ` — ${Object.entries(byType).map(([t, n]) => `${t}: ${n}`).join(", ")}` : "") +
          (truncated ? ` (truncated at maxPages; continue with next="${more}")` : "");
        return ok({ value: widgets, next: more, truncated }, summary);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // 4. mural_create_sticky_note ------------------------------------------
  server.registerTool(
    TOOLS.createStickyNote.name,
    {
      title: "Create sticky note",
      description:
        "Creates a sticky note at Cartesian canvas coordinates (x, y) with text content, shape and colour styling. " +
        'Example: a yellow rectangular note reading "Hello" at x:200, y:300.',
      inputSchema: {
        muralId: muralIdSchema,
        x: z.number().describe("Horizontal position in canvas pixels (left edge)."),
        y: z.number().describe("Vertical position in canvas pixels (top edge)."),
        text: z.string().default("").describe("Plain-text content of the note."),
        shape: z.enum(["rectangle", "circle"]).default("rectangle"),
        color: z
          .string()
          .optional()
          .describe(`Background colour: name (${NAMED_COLORS.join(", ")}) or hex #RRGGBB / #RRGGBBAA. Default yellow.`),
        width: z.number().positive().optional().describe("Width in px (default 138)."),
        height: z.number().positive().optional().describe("Height in px (default 138)."),
        title: z.string().optional().describe("Outline title for the note."),
        style: styleSchema.optional().describe("Additional text styling. `color` overrides style.backgroundColor."),
        rotation: z.number().min(0).max(360).optional().describe("Degrees clockwise. Mural pivots around the TOP-LEFT corner; use anchor=\"center\" to pivot visually around the centre."),
        anchor: z.enum(["top-left", "center"]).default("top-left").describe('"top-left" (Mural default: x/y is the corner and rotation pivots around it) or "center" (x/y is the visual centre of the element even when rotated; the server converts).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ muralId, x: ax, y: ay, text, shape, color, width, height, title, style, rotation, anchor }) => {
      try {
        const { x, y } = anchorToTopLeft(anchor, ax, ay, width ?? 138, height ?? 138, rotation);
        const apiStyle: StickyNoteStyle = { ...(toApiStyle(style) ?? {}) };
        if (color) apiStyle.backgroundColor = normalizeColor(color);
        const note: CreateStickyNoteInput & { rotation?: number } = { x, y, shape, text };
        if (rotation !== undefined) note.rotation = rotation;
        if (width !== undefined) note.width = width;
        if (height !== undefined) note.height = height;
        if (title !== undefined) note.title = title;
        if (Object.keys(apiStyle).length) note.style = apiStyle;

        const res = await client.createStickyNotes(muralId, [note]);
        const created = res.value?.[0];
        return ok(
          res,
          created ? `Created sticky note ${created.id} at (${x}, ${y})` : "Sticky note created",
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // 5. mural_update_widget -----------------------------------------------
  server.registerTool(
    TOOLS.updateWidget.name,
    {
      title: "Update widget",
      description:
        "Applies mutations to an existing canvas element: text, coordinates (x/y), size (width/height), rotation or style. " +
        "The widget type is looked up automatically unless `widgetType` is supplied. Only the fields you pass are changed.",
      inputSchema: {
        muralId: muralIdSchema,
        widgetId: z.string().min(1).describe("Id of the widget to update (from mural_get_widgets)."),
        widgetType: z
          .string()
          .optional()
          .describe(
            'Optional widget type to skip the lookup: "sticky note", "text", "shape", "title", "arrow", "area", "image", "table", "comment".',
          ),
        text: z.string().optional().describe("New plain-text content."),
        htmlText: z.string().optional().describe("New content with HTML formatting."),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        rotation: z.number().optional().describe("Rotation in degrees."),
        title: z.string().optional(),
        hidden: z.boolean().optional(),
        parentId: z.string().optional().describe("Move the widget into a parent (e.g. an area)."),
        style: styleSchema.optional().describe("Style changes; backgroundColor accepts names or hex."),
        extra: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Escape hatch: additional raw fields merged into the PATCH body for type-specific properties."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ muralId, widgetId, widgetType, style, extra, ...fields }) => {
      try {
        const patch: Record<string, unknown> = { ...(extra ?? {}) };
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) patch[k] = v;
        const apiStyle = toApiStyle(style);
        if (apiStyle && Object.keys(apiStyle).length) patch.style = apiStyle;
        if (!Object.keys(patch).length) {
          return { content: [{ type: "text", text: "Nothing to update: pass at least one field." }], isError: true };
        }
        const { widget, resolvedType } = await client.updateWidget(muralId, widgetId, patch, widgetType);
        return ok(
          { widget, patch, widgetType: resolvedType },
          `Updated ${resolvedType} widget ${widgetId} (${Object.keys(patch).join(", ")})`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // 6+. shapes, text boxes, titles, arrows/lines, areas, delete, raw
  registerWidgetTools(server, client);
  // board-level: rooms, murals, export, snapshot, tags, images, files, comments
  registerBoardTools(server, client, cfg.requestTimeoutMs);
  // higher-level drawing: batch draw, tables
  registerDrawTools(server, client);

  return server;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  let cfg: MuralConfig;
  try {
    cfg = await loadConfig();
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const httpMode = process.argv.includes("--http");
  log(
    `starting v${SERVER_VERSION} (${httpMode ? "http" : "stdio"}); api=${cfg.apiBaseUrl}; env file=${cfg.envFile ?? "none"}; ` +
      `secrets=${cfg.secrets.backend}${cfg.secrets.service ? ` (service "${cfg.secrets.service}"; from keychain: ${cfg.secrets.loaded.join(",") || "nothing"})` : ""}; ` +
      `client id=${cfg.clientId ? "set" : "unset"}; refresh=${cfg.refreshToken && cfg.clientId && cfg.clientSecret ? "enabled" : "disabled"}; ` +
      `scopes=${configuredScopes().join(",")}`,
  );

  if (httpMode) {
    // One MuralClient shared by all sessions so token refresh happens once.
    const client = new MuralClient(cfg);
    const port = Number(argValue("--port") ?? process.env.MURAL_HTTP_PORT ?? 50010);
    const host = argValue("--host") ?? process.env.MURAL_HTTP_HOST ?? "127.0.0.1";
    const { url, close } = await startHttp({
      host,
      port,
      secret: process.env.MURAL_HTTP_SECRET?.trim() || undefined,
      bearer: process.env.MURAL_HTTP_BEARER?.trim() || undefined,
      makeServer: () => buildServer(cfg, client),
      log,
    });
    log(`listening on ${url}${process.env.MURAL_HTTP_BEARER ? " (bearer required)" : ""}`);
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !process.env.MURAL_HTTP_BEARER && !process.env.MURAL_HTTP_SECRET) {
      log("WARNING: bound to a non-loopback address with no MURAL_HTTP_SECRET or MURAL_HTTP_BEARER — anyone who reaches this port can edit your murals.");
    }
    const shutdown = (signal: string) => {
      log(`received ${signal}, shutting down`);
      close();
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    return;
  }

  const server = buildServer(cfg);
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string) => {
    log(`received ${signal}, shutting down`);
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  log("connected over stdio; awaiting JSON-RPC requests");
}

main().catch((err) => {
  log("fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
