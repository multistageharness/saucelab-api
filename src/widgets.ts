/**
 * Widget-creation tools beyond sticky notes: shapes, text boxes, titles,
 * arrows/lines, areas, plus delete and a raw escape hatch.
 * Schemas were taken from the Mural Public API reference and confirmed against
 * the live validator (which is stricter than the docs in places — see notes).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeColor, NAMED_COLORS } from "./colors.js";
import { MuralApiError, type MuralClient } from "./mural-client.js";
import { anchorToTopLeft } from "./geometry.js";

export const SHAPE_NAMES = [
  "rectangle", "square", "rounded_square", "circle", "ellipse", "triangle", "right_triangle", "diamond",
  "pentagon", "hexagon", "octagon", "star", "trapezoid", "cross", "cloud", "ribbon", "simple_ribbon", "badge",
  "arrow_right", "arrow_left", "arrow_top", "arrow_down", "arrow_left_right", "brace_left", "brace_right",
  "speech_bubble_left", "speech_bubble_right", "speech_bubble_center", "thinking_bubble_left", "thinking_bubble_right",
  "teardrop_bubble", "note_left", "note_right",
  // flowchart
  "process", "decision", "terminator", "start", "end", "step", "data", "database", "document", "document_shape",
  "multiple_documents", "predefined_process", "preparation", "manual_input", "manual_loop", "loop_limit", "delay",
  "display", "stored_data", "internal_storage", "direct_data", "papertape", "merge", "or", "summing_junction",
  "connector", "off_page_connector", "off_page_reference", "off_page_reference_incoming", "event_shape",
  "hexagon_smart", "pentagon_smart", "rhombus_smart", "triangle_smart", "porongo", "chonk_unicorn",
] as const;


/** Arrow label payload as the live validator requires: full `format` + positioned `labels`. Coordinates are relative to the arrow's bounding box. */
export function arrowLabel(text: string, width: number, height: number, fontSize = 14): Record<string, unknown> {
  const w = Math.max(60, Math.round(text.length * fontSize * 0.6) + 16), h = Math.round(fontSize * 1.8);
  return {
    format: { bold: false, italic: false, color: "#000000FF", fontFamily: "proxima-nova", fontSize, textAlign: "center" },
    labels: [{ text, x: Math.round(width / 2 - w / 2), y: Math.round(height / 2 - h / 2), width: w, height: h }],
  };
}

const COLOR_DESC = `Colour name (${NAMED_COLORS.join(", ")}) or hex #RRGGBB / #RRGGBBAA.`;
const muralId = z.string().min(1).describe('Mural (board) id, e.g. "workspace.1234567890".');
const parentId = z.string().optional().describe("Parent area widget id to place this inside.");
const rotation = z.number().min(0).max(360).optional().describe("Rotation in degrees, clockwise, pivoting on the TOP-LEFT corner (Mural behaviour). Use anchor=\"center\" to pivot visually around the centre.");
const anchor = z.enum(["top-left", "center"]).default("top-left").describe('"top-left" (Mural default: x/y is the corner and rotation pivots around it) or "center" (x/y is the visual centre of the element even when rotated; the server converts).');
const stackingOrder = z.number().int().optional().describe("Z-order; higher is on top.");
const textAlign = z.enum(["left", "center", "right"]).optional();
const font = z.string().optional().describe("adelle | blambot-casual | blambot-pro | lint-mccree | marker-felt | museo-slab | proxima-nova | shark-water");

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (data: unknown, summary: string): ToolResult => ({ content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }] });
const fail = (err: unknown): ToolResult => {
  const msg = err instanceof Error ? err.message : String(err);
  const body = err instanceof MuralApiError && err.body !== undefined ? `\n\nResponse body:\n${typeof err.body === "string" ? err.body : JSON.stringify(err.body, null, 2)}` : "";
  return { content: [{ type: "text", text: msg + body }], isError: true };
};
const strip = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
const firstId = (res: unknown): string | undefined => {
  const r = res as { value?: Array<{ id?: string }> | { id?: string } } | { id?: string };
  const v = (r as { value?: unknown }).value;
  if (Array.isArray(v)) return v[0]?.id;
  if (v && typeof v === "object") return (v as { id?: string }).id;
  return (r as { id?: string }).id;
};

export function registerWidgetTools(server: McpServer, client: MuralClient): void {
  // ---- shape --------------------------------------------------------------
  server.registerTool(
    "mural_create_shape",
    {
      title: "Create shape",
      description:
        "Creates a true shape widget (not a sticky note): rectangle, circle, ellipse, triangle, diamond, star, cloud, block arrows, " +
        "speech bubbles and the full flowchart set (process, decision, terminator, database, document, ...). Optional text inside the shape. " +
        "Live validator note: shapes accept backgroundColor, borderWidth and borderStyle (solid|dotted) but NOT borderColor, fontSize or textAlign.",
      inputSchema: {
        muralId,
        shape: z.enum(SHAPE_NAMES).describe("Shape name."),
        x: z.number(), y: z.number(),
        width: z.number().positive().default(200), height: z.number().positive().default(200),
        text: z.string().optional().describe("Plain text shown inside the shape."),
        color: z.string().optional().describe(`Fill colour. ${COLOR_DESC}`),
        borderWidth: z.number().int().min(0).optional(),
        borderStyle: z.enum(["solid", "dotted"]).optional(),
        rotation, anchor, parentId, stackingOrder,
        title: z.string().optional().describe("Outline title."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ muralId: id, shape, x: ax, y: ay, width, height, text, color, borderWidth, borderStyle, rotation: rot, anchor: an, parentId: pid, stackingOrder: so, title }) => {
      try {
        const { x, y } = anchorToTopLeft(an, ax, ay, width, height, rot);
        const style = strip({ backgroundColor: color ? normalizeColor(color) : undefined, borderWidth, borderStyle });
        const body = strip({ shape, x, y, width, height, text, rotation: rot, parentId: pid, stackingOrder: so, title, style: Object.keys(style).length ? style : undefined });
        const res = await client.createWidgets(id, "shape", [body]);
        return ok(res, `Created ${shape} ${firstId(res) ?? ""} at (${x}, ${y}) ${width}x${height}`);
      } catch (e) { return fail(e); }
    },
  );

  // ---- text box -----------------------------------------------------------
  server.registerTool(
    "mural_create_textbox",
    {
      title: "Create text box",
      description: "Creates a free text box (transparent background by default). Text may contain simple HTML (<b>, <i>, <br>, lists).",
      inputSchema: {
        muralId, x: z.number(), y: z.number(),
        text: z.string().describe("Text or simple HTML."),
        width: z.number().positive().default(296), height: z.number().positive().optional(),
        fontSize: z.number().int().positive().optional().describe("Default 24."),
        textAlign, font,
        color: z.string().optional().describe(`Background colour (default transparent). ${COLOR_DESC}`),
        rotation, anchor, parentId, stackingOrder,
        hyperlink: z.string().url().optional(), hyperlinkTitle: z.string().optional(),
        title: z.string().optional().describe("Outline title."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ muralId: id, color, fontSize, textAlign: ta, font: f, rotation: rot, anchor: an, parentId: pid, stackingOrder: so, ...rest }) => {
      try {
        const { x, y } = anchorToTopLeft(an, rest.x, rest.y, rest.width, rest.height ?? 28, rot);
        const style = strip({ backgroundColor: color ? normalizeColor(color) : undefined, fontSize, textAlign: ta, font: f });
        const body = strip({ ...rest, x, y, rotation: rot, parentId: pid, stackingOrder: so, style: Object.keys(style).length ? style : undefined });
        const res = await client.createWidgets(id, "textbox", [body]);
        return ok(res, `Created text box ${firstId(res) ?? ""} at (${rest.x}, ${rest.y})`);
      } catch (e) { return fail(e); }
    },
  );

  // ---- title --------------------------------------------------------------
  server.registerTool(
    "mural_create_title",
    {
      title: "Create title",
      description: "Creates a large title/heading widget (default 48px).",
      inputSchema: {
        muralId, x: z.number(), y: z.number(),
        text: z.string(),
        width: z.number().positive().default(293), height: z.number().positive().optional(),
        fontSize: z.number().int().positive().optional().describe("Default 48."),
        textAlign, font,
        color: z.string().optional().describe(`Background colour (default transparent). ${COLOR_DESC}`),
        rotation, anchor, parentId, stackingOrder,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ muralId: id, color, fontSize, textAlign: ta, font: f, rotation: rot, anchor: an, parentId: pid, stackingOrder: so, ...rest }) => {
      try {
        const { x, y } = anchorToTopLeft(an, rest.x, rest.y, rest.width, rest.height ?? 62, rot);
        const style = strip({ backgroundColor: color ? normalizeColor(color) : undefined, fontSize, textAlign: ta, font: f });
        const body = strip({ ...rest, x, y, rotation: rot, parentId: pid, stackingOrder: so, style: Object.keys(style).length ? style : undefined });
        const res = await client.createWidgets(id, "title", [body]);
        return ok(res, `Created title ${firstId(res) ?? ""} at (${rest.x}, ${rest.y})`);
      } catch (e) { return fail(e); }
    },
  );

  // ---- arrow / line -------------------------------------------------------
  server.registerTool(
    "mural_create_arrow",
    {
      title: "Create arrow or line",
      description:
        "Draws a line or arrow. Give at least two `points` in canvas coordinates; the bounding box (x/y/width/height) is computed for you. " +
        "Set tip to 'no tip' for a plain line, 'single' (default) or 'double'. To connect two widgets so the arrow follows them, pass startRefId/endRefId " +
        "(their widget ids) in addition to the points.",
      inputSchema: {
        muralId,
        points: z.array(z.object({ x: z.number(), y: z.number() })).min(2).describe("Polyline/anchor points in canvas pixels; first is the tail, last is the head."),
        arrowType: z.enum(["straight", "curved", "orthogonal", "bezier"]).default("straight"),
        tip: z.enum(["no tip", "single", "double"]).default("single"),
        color: z.string().optional().describe(`Stroke colour (default black). ${COLOR_DESC}`),
        strokeWidth: z.number().int().min(1).max(7).optional().describe("1-7, default 3."),
        strokeStyle: z.enum(["solid", "dashed", "dotted-spaced", "dotted"]).optional(),
        startRefId: z.string().optional().describe("Widget id the tail is attached to."),
        endRefId: z.string().optional().describe("Widget id the head is attached to."),
        label: z.string().optional().describe("Text label on the arrow."),
        parentId, stackingOrder,
        title: z.string().optional().describe("Outline title."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ muralId: id, points, arrowType, tip, color, strokeWidth, strokeStyle, startRefId, endRefId, label, parentId: pid, stackingOrder: so, title }) => {
      try {
        const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
        const minX = Math.min(...xs), minY = Math.min(...ys);
        const width = Math.max(1, Math.max(...xs) - minX), height = Math.max(1, Math.max(...ys) - minY);
        const style = strip({ strokeColor: color ? normalizeColor(color) : undefined, strokeWidth, strokeStyle });
        const body = strip({
          x: minX, y: minY, width, height,
          points: points.map((p) => ({ x: p.x - minX, y: p.y - minY })),
          arrowType, tip, startRefId, endRefId, parentId: pid, stackingOrder: so, title,
          label: label ? arrowLabel(label, width, height) : undefined,
          style: Object.keys(style).length ? style : undefined,
        });
        const res = await client.createWidget(id, "arrow", body);
        return ok(res, `Created ${tip === "no tip" ? "line" : "arrow"} ${firstId(res) ?? ""} from (${points[0].x}, ${points[0].y}) to (${points.at(-1)!.x}, ${points.at(-1)!.y})`);
      } catch (e) { return fail(e); }
    },
  );

  // ---- area ---------------------------------------------------------------
  server.registerTool(
    "mural_create_area",
    {
      title: "Create area",
      description: "Creates an area (titled container/frame). Other widgets can be placed inside it via their parentId.",
      inputSchema: {
        muralId, title: z.string().describe("Area title (shown unless showTitle=false)."),
        x: z.number(), y: z.number(),
        width: z.number().positive().default(460), height: z.number().positive().default(503),
        layout: z.enum(["free", "column", "row"]).optional(),
        showTitle: z.boolean().optional(),
        color: z.string().optional().describe(`Background colour. ${COLOR_DESC}`),
        borderColor: z.string().optional().describe(COLOR_DESC),
        borderWidth: z.number().int().min(0).optional(),
        borderStyle: z.enum(["solid", "dotted"]).optional(),
        titleFontSize: z.number().int().positive().optional(),
        parentId, stackingOrder,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ muralId: id, color, borderColor, borderWidth, borderStyle, titleFontSize, parentId: pid, stackingOrder: so, ...rest }) => {
      try {
        const style = strip({ backgroundColor: color ? normalizeColor(color) : undefined, borderColor: borderColor ? normalizeColor(borderColor) : undefined, borderWidth, borderStyle, titleFontSize });
        const body = strip({ ...rest, parentId: pid, stackingOrder: so, style: Object.keys(style).length ? style : undefined });
        const res = await client.createWidget(id, "area", body); // live API: single object, not array
        return ok(res, `Created area "${rest.title}" ${firstId(res) ?? ""} at (${rest.x}, ${rest.y})`);
      } catch (e) { return fail(e); }
    },
  );

  // ---- delete -------------------------------------------------------------
  server.registerTool(
    "mural_delete_widget",
    {
      title: "Delete widget",
      description: "Permanently deletes a widget (any type). Deleting an area also deletes every widget parented inside it; deleting a table deletes its cells.",
      inputSchema: { muralId, widgetId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ muralId: id, widgetId }) => {
      try {
        await client.deleteWidget(id, widgetId);
        return { content: [{ type: "text", text: `Deleted widget ${widgetId}` }] };
      } catch (e) { return fail(e); }
    },
  );

  // ---- raw escape hatch ---------------------------------------------------
  server.registerTool(
    "mural_create_widgets_raw",
    {
      title: "Create widgets (raw API)",
      description:
        "Escape hatch: POST a raw payload to /murals/{id}/widgets/{type}. Use for types without a dedicated tool (table, image, file, comment) " +
        "or for batch creation. `type` is the API path segment (sticky-note, shape, textbox, title, arrow, area, table, image, file, comment). " +
        "sticky-note/shape/textbox/title take an ARRAY body; arrow/area/table/image/file/comment take a single OBJECT. Colours must be #RRGGBBAA.",
      inputSchema: {
        muralId,
        type: z.string().min(1),
        body: z.union([z.array(z.record(z.string(), z.unknown())), z.record(z.string(), z.unknown())]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ muralId: id, type, body }) => {
      try {
        const res = Array.isArray(body) ? await client.createWidgets(id, type, body) : await client.createWidget(id, type, body);
        return ok(res, `POST /widgets/${type} ok`);
      } catch (e) { return fail(e); }
    },
  );
}
