# AGENT.md — drawing on Mural through this MCP server

This server turns a Mural board into a vector canvas an agent can draw on. Everything the Mural
Public API allows is exposed as a tool; what the API does not allow is listed in **Not possible**
at the end. The claims here reflect the live API's behaviour as encoded in the code (see README,
"Live API behaviour encoded in the code").

## Mental model

- A **mural** (board) is a fixed-size or infinite canvas measured in **pixels**, origin top-left,
  x to the right, y downward. `mural_get_board` returns `width`/`height` (e.g. 9216×6237).
- Everything on it is a **widget** with `id`, `type`, `x`, `y`, `width`, `height`, `rotation`,
  `stackingOrder` (z-order), optional `parentId` (an **area** that contains it).
- Board id format: `<workspace>.<number>`, visible in the URL after `/m/<workspace>/`.
- Colours: pass names (`yellow`, `light blue`, `red`, …) or hex `#RRGGBB` / `#RRGGBBAA`; the
  server normalises to Mural's `#RRGGBBAA`.
- A board open in a browser tab renders changes live.

## Capability matrix

| Capability | Tool | Notes |
|---|---|---|
| Find workspaces / rooms / boards | `mural_list_workspaces`, `mural_list_rooms`, `mural_list_murals` | rooms are needed to create boards |
| Create / duplicate / rename a board | `mural_create_board`, `mural_duplicate_board`, `mural_update_board` | boards cannot be deleted via API |
| Read board geometry & metadata | `mural_get_board` | |
| Read all elements | `mural_get_widgets` (auto-paginates), `mural_get_widget` | filter by type |
| **Shapes** (70 kinds) | `mural_create_shape`, or `mural_draw` kind `shape` | rectangle, square, rounded_square, circle, ellipse, triangle, right_triangle, diamond, pentagon, hexagon, octagon, star, trapezoid, cross, cloud, ribbon, badge, block arrows (arrow_right/left/top/down/left_right), braces, speech/thinking bubbles, notes, and the flowchart set: process, decision, terminator, start, end, step, data, database, document, multiple_documents, predefined_process, preparation, manual_input, manual_loop, loop_limit, delay, display, stored_data, internal_storage, direct_data, papertape, merge, or, summing_junction, connector, off_page_connector/reference, event_shape, *_smart variants |
| Shape fill / border / text | same | fill colour, `borderWidth`, `borderStyle` solid\|dotted, text inside. **No border colour, font size or alignment on shapes** (API rejects them) |
| **Lines & arrows** | `mural_create_arrow`, or `mural_draw` kind `arrow` | polyline points; `straight` \| `curved` \| `orthogonal` \| `bezier`; tip `no tip` (plain line) \| `single` \| `double`; colour, width 1-7, solid/dashed/dotted; optional label; attach ends to widgets with `startRefId`/`endRefId` (`from`/`to` in batch) so they follow when moved |
| **Text** | `mural_create_textbox`, `mural_create_title`, `mural_draw` kinds `text`/`title` | simple HTML allowed (`<b>`, `<i>`, `<br>`, lists); font family, size, alignment, optional background |
| Sticky notes | `mural_create_sticky_note`, `mural_draw` kind `sticky` | rectangle or circle, any colour/size |
| Containers / frames | `mural_create_area`, `mural_draw` kind `area` | titled; layouts free/column/row; put children inside via `parentId` |
| **Tables** | `mural_create_table` | grid of strings → cells with font/size/alignment/colour; header row |
| Images | `mural_create_image` | from URL or base64; png/jpg/jpeg/gif/webp/bmp/ico; uploaded to Mural's asset store first |
| Files | `mural_create_file` | from URL (e.g. PDF) |
| Comments | `mural_create_comment` | pinned at x/y |
| Tags | `mural_list_tags`, `mural_create_tag` | attach via `mural_update_widget` `extra.tags` |
| Move / resize / restyle / retext | `mural_update_widget` | any field the type accepts; type is auto-detected; works for sticky notes, shapes, text boxes, titles, arrows (incl. new `points`), areas, images, comments |
| Layering | `stackingOrder` on create/update | higher is on top |
| Delete | `mural_delete_widget` | any widget. **Deleting an area deletes everything parented inside it**; deleting a table deletes its cells |
| **Batch diagrams** | `mural_draw` | up to 200 primitives in one call with handles; arrows auto-routed center-to-center and attached; stops at first failure and reports what was placed |
| Look at the result | `mural_snapshot` (PNG), `mural_export_pdf` | `mural_snapshot` exports a PDF (always current) and rasterizes it to PNG (5-30 s). Mural's own thumbnail is a cached image refreshed rarely — never use it to judge the current state (available via `source: "thumbnail"`, labelled STALE) |
| Anything else the API has | `mural_create_widgets_raw` | raw POST to `/widgets/{type}` |

## Rotation and placement (read before rotating anything)

- **Mural pivots rotation on the top-left corner `(x, y)`, not the centre.** The API's `x`/`y` are
  unchanged by `rotation`, so a note placed by its centre and then rotated swings out of place.
  Pass `anchor: "center"` (shape, sticky, text, title, and every `mural_draw` item) to give the
  visual centre instead; the server converts with
  `x = cx − (w/2)cosθ + (h/2)sinθ`, `y = cy − (w/2)sinθ − (h/2)cosθ`.
- Stacked sticky notes / `rectangle` shapes have rounded corners, so a stack meant to form a
  pyramid reads as steps. Use a `triangle` or `trapezoid` shape (or layered triangles) for
  pyramids and funnels; for true bars use `rectangle` with `borderWidth: 0` overlapped by 2–4 px.
- Diagonal edges: a thin rotated `rectangle` or a `no tip` arrow is crisper than rotated notes.
- Details and formulas: `.claude/skills/mural-drawing-geometry/SKILL.md`.

## Drawing recipes

**Flowchart in one call**

```json
{ "muralId": "ws.123", "items": [
  { "kind": "title", "id": "t", "x": 100, "y": 40, "text": "Order flow", "fontSize": 40 },
  { "kind": "shape", "id": "start", "shape": "terminator", "x": 100, "y": 120, "width": 200, "height": 80, "text": "Start", "color": "light green" },
  { "kind": "shape", "id": "check", "shape": "decision", "x": 100, "y": 280, "width": 200, "height": 140, "text": "In stock?", "color": "light yellow" },
  { "kind": "shape", "id": "ship", "shape": "process", "x": 450, "y": 300, "width": 200, "height": 100, "text": "Ship", "color": "light blue" },
  { "kind": "shape", "id": "wait", "shape": "delay", "x": 100, "y": 520, "width": 200, "height": 100, "text": "Backorder", "color": "light orange" },
  { "kind": "arrow", "from": "start", "to": "check" },
  { "kind": "arrow", "from": "check", "to": "ship", "label": "yes", "arrowType": "orthogonal" },
  { "kind": "arrow", "from": "check", "to": "wait", "label": "no" }
]}
```

**Plain line / separator**: `{ "kind": "arrow", "points": [{"x":100,"y":700},{"x":900,"y":700}], "tip": "no tip", "strokeStyle": "dashed", "color": "gray" }`

**Polyline / freeform path**: an arrow with many `points` and `tip: "no tip"` (straight segments; use `bezier`/`curved` for smooth).

**Grouping**: create an `area` first (handle `a`), then give children `parentId: "a"`. Deleting the area later removes the children too.

**Layout tips**: keep ≥40 px gaps; shapes default to 200×200, text boxes 296 wide, sticky notes
138×138; put labels in a `text` item above/below a shape when the text doesn't fit; use
`stackingOrder` to keep arrows under labels.

**Verify**: call `mural_get_widgets` to read back positions, or `mural_snapshot` to see a current
picture (PDF export rendered to PNG, 5-30 s); `mural_export_pdf` for the full-resolution file.

## Not possible (API limitations, verified)

| Wanted | Status | Workaround |
|---|---|---|
| Freehand / pen strokes, brush drawing | **No endpoint** (`draw`, `drawing`, `line`, `icon` paths return 404) | approximate with polyline arrows (`tip: "no tip"`) or many small shapes |
| Arbitrary SVG / bezier filled paths, polygons with custom vertices | Not supported; shapes are the fixed catalogue above | compose from shapes + polylines; or render to PNG and place with `mural_create_image` |
| Border colour, font size, text alignment on shapes | Rejected by validator | use a text box over a shape; sticky notes support text styling |
| Editing tables / cells after creation | `PATCH` on table and table cell returns 404 | delete the table and recreate |
| Editing titles' text via PATCH /title | works; but tables, files have no update | — |
| Icons widget type | listed in the type filter, no create endpoint | use an image |
| Export to PNG/SVG | export accepts `pdf` only | `mural_snapshot` rasterizes the PDF locally to PNG (needs sips/macOS or pdftoppm); no SVG |
| Live board thumbnail | `thumbnailUrl` is a cached image Mural refreshes rarely | never use it as "current"; use `mural_snapshot` (render) |
| Deleting a board | no public endpoint | delete in the Mural UI |
| Current user / templates (`/users/me`, `/templates`) | require `identity:read` / `templates:read`, which are not in the default scope list | enable them on the integration, set `MURAL_SCOPES`, and re-run `make auth` |
| Real-time cursor/selection, presentation mode, timers, voting, private mode | not exposed as tools (private-mode endpoints exist but are facilitation, not drawing) | `mural_create_widgets_raw` cannot reach them; raise if needed |
| Fonts | limited to Mural's list: adelle, blambot-casual, blambot-pro, lint-mccree, marker-felt, museo-slab, proxima-nova, shark-water, abc-social, stk-bureau-serif, ey-interstate, itc-garamond-condensed | — |
| Image widgets from a local path | server only takes URL or base64 | base64-encode the file |

## Operational notes

- Every write needs `murals:write`; rooms/boards need `rooms:*`, `workspaces:read`. The token
  refreshes itself (15-minute access tokens) when a refresh token is in the keychain or `.env`.
- Rate limits are not documented; `mural_draw` creates items sequentially. Expect ~0.3 s per item.
- IDs returned by create calls are stable; store them if you plan to move or connect things later.
