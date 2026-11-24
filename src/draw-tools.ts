/**
 * Higher-level drawing tools: tables from a text grid, and a batch `draw`
 * command that places many primitives in one call with cross-references.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeColor } from "./colors.js";
import { MuralApiError, type MuralClient } from "./mural-client.js";
import { SHAPE_NAMES, arrowLabel } from "./widgets.js";
import { anchorToTopLeft } from "./geometry.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (data: unknown, summary: string): ToolResult => ({ content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }] });
const fail = (err: unknown): ToolResult => {
  const msg = err instanceof Error ? err.message : String(err);
  const body = err instanceof MuralApiError && err.body !== undefined ? `\n\nResponse body:\n${typeof err.body === "string" ? err.body : JSON.stringify(err.body, null, 2)}` : "";
  return { content: [{ type: "text", text: msg + body }], isError: true };
};
const strip = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
const muralId = z.string().min(1).describe('Mural (board) id, e.g. "workspace.1234567890".');
const FONTS = ["adelle", "blambot-casual", "blambot-pro", "lint-mccree", "marker-felt", "museo-slab", "proxima-nova", "shark-water", "abc-social", "stk-bureau-serif", "ey-interstate", "itc-garamond-condensed"] as const;

// ---------------------------------------------------------------------------
// Batch draw primitives
// ---------------------------------------------------------------------------
const pt = z.object({ x: z.number(), y: z.number() });
const common = { id: z.string().optional().describe("Your own handle for this item; later items may reference it (e.g. arrow from/to)."), parentId: z.string().optional().describe("Area id or a handle of an area created earlier in this batch."), stackingOrder: z.number().int().optional(), rotation: z.number().optional().describe("Degrees clockwise; Mural pivots on the top-left corner unless anchor=\"center\"."), anchor: z.enum(["top-left", "center"]).optional().describe('"top-left" (Mural default: x/y is the corner and rotation pivots around it) or "center" (x/y is the visual centre of the element even when rotated; the server converts).') };
const primitive = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shape"), shape: z.enum(SHAPE_NAMES), x: z.number(), y: z.number(), width: z.number().positive().default(200), height: z.number().positive().default(200), text: z.string().optional(), color: z.string().optional(), borderWidth: z.number().int().min(0).optional(), borderStyle: z.enum(["solid", "dotted"]).optional(), ...common }),
  z.object({ kind: z.literal("sticky"), x: z.number(), y: z.number(), text: z.string().default(""), shape: z.enum(["rectangle", "circle"]).default("rectangle"), color: z.string().optional(), width: z.number().positive().optional(), height: z.number().positive().optional(), ...common }),
  z.object({ kind: z.literal("text"), x: z.number(), y: z.number(), text: z.string(), width: z.number().positive().default(296), height: z.number().positive().optional(), fontSize: z.number().int().positive().optional(), textAlign: z.enum(["left", "center", "right"]).optional(), color: z.string().optional(), ...common }),
  z.object({ kind: z.literal("title"), x: z.number(), y: z.number(), text: z.string(), width: z.number().positive().default(293), fontSize: z.number().int().positive().optional(), textAlign: z.enum(["left", "center", "right"]).optional(), ...common }),
  z.object({ kind: z.literal("arrow"), points: z.array(pt).min(2).optional().describe("Absolute canvas points. Optional when from/to are given: the centers of those widgets are used."), from: z.string().optional().describe("Handle or widget id the tail attaches to."), to: z.string().optional().describe("Handle or widget id the head attaches to."), arrowType: z.enum(["straight", "curved", "orthogonal", "bezier"]).default("straight"), tip: z.enum(["no tip", "single", "double"]).default("single"), color: z.string().optional(), strokeWidth: z.number().int().min(1).max(7).optional(), strokeStyle: z.enum(["solid", "dashed", "dotted-spaced", "dotted"]).optional(), label: z.string().optional(), ...common }),
  z.object({ kind: z.literal("area"), title: z.string(), x: z.number(), y: z.number(), width: z.number().positive().default(460), height: z.number().positive().default(503), color: z.string().optional(), borderStyle: z.enum(["solid", "dotted"]).optional(), showTitle: z.boolean().optional(), layout: z.enum(["free", "column", "row"]).optional(), ...common }),
]);

type Placed = { handle?: string; id: string; type: string; x: number; y: number; width: number; height: number };

export function registerDrawTools(server: McpServer, client: MuralClient): void {
  server.registerTool("mural_draw", {
    title: "Draw (batch)",
    description:
      "Places many primitives in one call, in order: shapes, sticky notes, text, titles, arrows/lines, areas. Give items an `id` handle and refer to it from later " +
      "items (arrow `from`/`to`, `parentId`) — the tool resolves handles to real widget ids and attaches arrows to the referenced widgets. " +
      "Arrows without explicit points are drawn center-to-center between `from` and `to`. Stops at the first failure and reports what was placed. " +
      "Use this for diagrams (flowcharts, architecture, mind maps): fewer round-trips than one tool call per element.",
    inputSchema: { muralId, items: z.array(primitive).min(1).max(200) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ muralId: mid, items }) => {
    const placed: Placed[] = []; const byHandle = new Map<string, Placed>();
    const resolve = (ref?: string) => (ref ? byHandle.get(ref)?.id ?? ref : undefined);
    const geom = (ref?: string) => (ref ? byHandle.get(ref) : undefined);
    const style = (o: Record<string, unknown>) => { const s = strip(o); return Object.keys(s).length ? s : undefined; };
    try {
      for (const [i, it] of items.entries()) {
        const parentId = resolve(it.parentId);
        let created: { id?: string; type?: string; x?: number; y?: number; width?: number; height?: number } | undefined;
        if (it.kind === "shape") {
          const { x, y } = anchorToTopLeft(it.anchor, it.x, it.y, it.width, it.height, it.rotation);
          const r = await client.createWidgets(mid, "shape", [strip({ shape: it.shape, x, y, width: it.width, height: it.height, text: it.text, rotation: it.rotation, parentId, stackingOrder: it.stackingOrder, style: style({ backgroundColor: it.color ? normalizeColor(it.color) : undefined, borderWidth: it.borderWidth, borderStyle: it.borderStyle }) })]);
          created = r.value?.[0];
        } else if (it.kind === "sticky") {
          const { x, y } = anchorToTopLeft(it.anchor, it.x, it.y, it.width ?? 138, it.height ?? 138, it.rotation);
          const r = await client.createWidgets(mid, "sticky-note", [strip({ shape: it.shape, x, y, text: it.text, width: it.width, height: it.height, rotation: it.rotation, parentId, stackingOrder: it.stackingOrder, style: style({ backgroundColor: it.color ? normalizeColor(it.color) : undefined }) })]);
          created = r.value?.[0];
        } else if (it.kind === "text") {
          const { x, y } = anchorToTopLeft(it.anchor, it.x, it.y, it.width, it.height ?? 28, it.rotation);
          const r = await client.createWidgets(mid, "textbox", [strip({ x, y, text: it.text, width: it.width, height: it.height, rotation: it.rotation, parentId, stackingOrder: it.stackingOrder, style: style({ fontSize: it.fontSize, textAlign: it.textAlign, backgroundColor: it.color ? normalizeColor(it.color) : undefined }) })]);
          created = r.value?.[0];
        } else if (it.kind === "title") {
          const { x, y } = anchorToTopLeft(it.anchor, it.x, it.y, it.width, 62, it.rotation);
          const r = await client.createWidgets(mid, "title", [strip({ x, y, text: it.text, width: it.width, rotation: it.rotation, parentId, stackingOrder: it.stackingOrder, style: style({ fontSize: it.fontSize, textAlign: it.textAlign }) })]);
          created = r.value?.[0];
        } else if (it.kind === "area") {
          const r = await client.createWidget(mid, "area", strip({ title: it.title, x: it.x, y: it.y, width: it.width, height: it.height, showTitle: it.showTitle, layout: it.layout, parentId, stackingOrder: it.stackingOrder, style: style({ backgroundColor: it.color ? normalizeColor(it.color) : undefined, borderStyle: it.borderStyle }) })) as typeof created;
          created = r;
        } else if (it.kind === "arrow") {
          let points = it.points;
          if (!points) {
            const a = geom(it.from), b = geom(it.to);
            if (!a || !b) throw new Error(`item ${i}: arrow needs explicit points, or from/to handles placed earlier in this batch`);
            points = [{ x: a.x + a.width / 2, y: a.y + a.height / 2 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 }];
          }
          const xs = points.map((p) => p.x), ys = points.map((p) => p.y); const minX = Math.min(...xs), minY = Math.min(...ys);
          const bw = Math.max(1, Math.max(...xs) - minX), bh = Math.max(1, Math.max(...ys) - minY);
          const body = strip({ x: minX, y: minY, width: bw, height: bh, points: points.map((p) => ({ x: p.x - minX, y: p.y - minY })), arrowType: it.arrowType, tip: it.tip, startRefId: resolve(it.from), endRefId: resolve(it.to), parentId, stackingOrder: it.stackingOrder, label: it.label ? arrowLabel(it.label, bw, bh) : undefined, style: style({ strokeColor: it.color ? normalizeColor(it.color) : undefined, strokeWidth: it.strokeWidth, strokeStyle: it.strokeStyle }) });
          created = (await client.createWidget(mid, "arrow", body)) as typeof created;
        }
        if (!created?.id) throw new Error(`item ${i} (${it.kind}): API returned no id`);
        const p: Placed = { handle: it.id, id: created.id, type: created.type ?? it.kind, x: created.x ?? 0, y: created.y ?? 0, width: created.width ?? 0, height: created.height ?? 0 };
        placed.push(p); if (it.id) byHandle.set(it.id, p);
      }
      return ok({ placed }, `Placed ${placed.length} item(s)`);
    } catch (e) {
      const r = fail(e); r.content[0].text = `Failed after placing ${placed.length}/${items.length} item(s).\n${r.content[0].text}\n\nPlaced so far:\n${JSON.stringify(placed, null, 2)}`; return r;
    }
  });

  // ---------------------------------------------------------------------------
  // Table from a text grid
  // ---------------------------------------------------------------------------
  server.registerTool("mural_create_table", {
    title: "Create table",
    description:
      "Creates a table from a grid of strings (rows of cells). Column widths / row heights default to 160x48. First row can be styled as a header. " +
      "NOTE: the API cannot edit tables or cells after creation — delete and recreate to change them.",
    inputSchema: {
      muralId, x: z.number(), y: z.number(),
      rows: z.array(z.array(z.string())).min(1).describe("Grid of cell texts, row-major. Ragged rows are padded with empty cells."),
      columnWidths: z.array(z.number().positive()).optional(), rowHeights: z.array(z.number().positive()).optional(),
      cellWidth: z.number().positive().default(160), cellHeight: z.number().positive().default(48),
      fontSize: z.number().int().positive().default(14), fontFamily: z.enum(FONTS).default("proxima-nova"), textAlign: z.enum(["left", "center", "right"]).default("left"),
      cellColor: z.string().optional().describe("Default cell background (colour name or hex). Mural default is yellow."),
      headerRow: z.boolean().default(false).describe("Style the first row as a header (bold-ish via colour)."), headerColor: z.string().default("light blue"),
      borderColor: z.string().optional(), borderWidth: z.number().int().min(0).optional(), title: z.string().optional(), parentId: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ muralId: mid, x, y, rows, columnWidths, rowHeights, cellWidth, cellHeight, fontSize, fontFamily, textAlign, cellColor, headerRow, headerColor, borderColor, borderWidth, title, parentId }) => {
    try {
      const nCols = Math.max(...rows.map((r) => r.length));
      const widths = Array.from({ length: nCols }, (_, c) => columnWidths?.[c] ?? cellWidth);
      const heights = rows.map((_, r) => rowHeights?.[r] ?? cellHeight);
      const columns = widths.map((w, c) => ({ columnId: `c${c + 1}`, width: w }));
      const rowDefs = heights.map((h, r) => ({ rowId: `r${r + 1}`, height: h }));
      const cells: Record<string, unknown>[] = [];
      let cy = 0;
      rows.forEach((row, r) => {
        let cx = 0;
        for (let c = 0; c < nCols; c++) {
          const bg = headerRow && r === 0 ? normalizeColor(headerColor) : cellColor ? normalizeColor(cellColor) : undefined;
          cells.push(strip({ columnId: `c${c + 1}`, rowId: `r${r + 1}`, x: cx, y: cy, width: widths[c], height: heights[r], style: bg ? { backgroundColor: bg } : undefined,
            textContent: { text: row[c] ?? "", fontFamily, fontSize, textAlign, verticalAlign: "middle", orientation: "horizontal", padding: 4 } }));
          cx += widths[c];
        }
        cy += heights[r];
      });
      const body = strip({ x, y, width: widths.reduce((a, b) => a + b, 0), height: heights.reduce((a, b) => a + b, 0), columns, rows: rowDefs, cells, title, parentId, style: borderColor || borderWidth !== undefined ? strip({ borderColor: borderColor ? normalizeColor(borderColor) : undefined, borderWidth }) : undefined });
      const res = await client.createWidget(mid, "table", body);
      const items = Array.isArray(res) ? res : (res as { value?: unknown[] }).value ?? [res];
      const table = (items as Array<{ type?: string; id?: string }>).find((w) => w.type === "table");
      return ok({ tableId: table?.id, cells: items.length - 1 }, `Created table ${table?.id ?? ""} (${rows.length}x${nCols})`);
    } catch (e) { return fail(e); }
  });
}
