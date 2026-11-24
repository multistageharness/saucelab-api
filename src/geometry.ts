/**
 * Rotation geometry. Mural rotates a widget around its TOP-LEFT corner (x, y),
 * not its centre (observed on the canvas; the API's x/y do not change with
 * rotation). Agents think in centres, so convert when asked.
 */
export type Anchor = "top-left" | "center";

/** Top-left (x, y) to send so that a w×h widget rotated by `deg` about its top-left ends up centred on (cx, cy). */
export function topLeftForCenterRotation(cx: number, cy: number, w: number, h: number, deg = 0): { x: number; y: number } {
  const t = (deg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  // centre after rotation about (x, y) = (x, y) + R(t)·(w/2, h/2)
  return { x: Math.round(cx - (w / 2) * cos + (h / 2) * sin), y: Math.round(cy - (w / 2) * sin - (h / 2) * cos) };
}

/** Apply `anchor` semantics to a requested (x, y): with "center" the caller meant the visual centre. */
export function anchorToTopLeft(anchor: Anchor | undefined, x: number, y: number, w: number, h: number, deg = 0): { x: number; y: number } {
  return anchor === "center" ? topLeftForCenterRotation(x, y, w, h, deg) : { x, y };
}

/** Axis-aligned bounding box of a w×h widget at top-left (x, y) rotated `deg` about that corner. */
export function rotatedBounds(x: number, y: number, w: number, h: number, deg = 0): { minX: number; minY: number; maxX: number; maxY: number } {
  const t = (deg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([px, py]) => [x + px * cos - py * sin, y + px * sin + py * cos]);
  return { minX: Math.min(...pts.map((p) => p[0])), minY: Math.min(...pts.map((p) => p[1])), maxX: Math.max(...pts.map((p) => p[0])), maxY: Math.max(...pts.map((p) => p[1])) };
}
