---
name: excalidraw-skill
description: Programmatic canvas toolkit for creating, editing, and refining Excalidraw diagrams via MCP tools with real-time canvas sync. Use when an agent needs to (1) draw or lay out diagrams on a live canvas, (2) iteratively refine diagrams using describe_scene and export_canvas to see its own work, (3) export/import .excalidraw files or PNG/SVG images, (4) save/restore canvas snapshots, (5) convert Mermaid to Excalidraw, or (6) perform element-level CRUD, alignment, distribution, grouping, duplication, and locking. Targets mcp-excalidraw-live v3+ (Streamable HTTP transport with human-grant access model).
---

# Excalidraw Skill (mcp-excalidraw-live v3+)

## Step 0: Get a canvas

This server uses a **human-grant model**. Before any drawing tool works, you must request a canvas and a human operator must grant access via the canvas dashboard.

1. Call `request_canvas(purpose: "<short description of what you'll draw>")`.
   - If `status: "granted"` → you have a canvas, proceed.
   - If `status: "pending"` → a human needs to click "Grant" in their browser. Tell the user:
     > Open the Excalidraw canvas in your browser, find the pending request from this session, and click **Grant**. Then I'll continue.
   - Wait, then call `request_canvas` again. It will return `granted` once the human approves.

2. (Optional) `list_my_canvases()` shows all canvases granted to your session.
3. (Optional) `select_canvas(canvasId)` switches the active target when you have multiple grants.
4. `release_canvas(canvasId)` voluntarily gives up a grant.

If `request_canvas` returns `"reason": "no canvases open"`, the human has not opened the canvas page yet. They must open the server URL in a browser first.

## Tool overview

### Element CRUD
- `create_element` — single element. For arrows: use `startElementId`/`endElementId` to bind to shapes; Excalidraw auto-routes from edge to edge.
- `batch_create_elements` — multiple at once. Same arrow binding rules apply.
- `update_element(id, ...)` — patch existing.
- `delete_element(id)`
- `get_element(id)`
- `query_elements({type?})` — list raw element data.
- `clear_canvas` — wipe.

### Inspection (use these to "see" your own work)
- `describe_scene` — text summary of all elements with positions, types, labels.
- `export_canvas(format: "png")` — visual screenshot you can read.
- `export_canvas(format: "svg")` — vector.
- `export_canvas(format: "excalidraw")` — native JSON (for save/inspection).

### Layout
- `align_elements(ids, alignment: left|center|right|top|middle|bottom)`
- `distribute_elements(ids, direction: horizontal|vertical)`
- `duplicate_elements(ids, offsetX?, offsetY?)`
- `group_elements(ids, action: group|ungroup)`
- `lock_elements(ids)` / `unlock_elements(ids)`
- `set_viewport({scrollToContent?, scrollToElementId?, zoom?})`

### Snapshots (in-memory bookmarks)
- `snapshot_scene(name)` — save current state under name. Per-canvas.
- `restore_snapshot(name)` — replace canvas with saved snapshot.
- `list_snapshots` — show saved names.

Use snapshots before risky changes so you can roll back without losing work.

### Files
- `save_canvas(filename_without_extension, format)` — write to disk (`.excalidraw`, `.png`, `.svg`, or array).
- `import_scene(filePath, mode: replace|merge)` — load `.excalidraw` from disk.

### Other
- `create_from_mermaid(mermaidDiagram)` — convert Mermaid string to elements.
- `export_to_excalidraw_url` — encrypted share link to excalidraw.com.
- `read_diagram_guide` — call this once before drawing for color palette + layout rules.

## Iterative refinement loop

1. `request_canvas("...")` → wait for grant
2. `read_diagram_guide` → load color/sizing rules
3. `snapshot_scene("base")` → bookmark empty/start state
4. Plan elements (use IDs you'll reference for arrow bindings)
5. `batch_create_elements([...])` with named IDs and `startElementId`/`endElementId` on arrows
6. `export_canvas("png")` → look at result
7. If wrong: `restore_snapshot("base")` and retry. If close: `update_element` for tweaks.
8. `describe_scene` to verify final layout

## Critical rules

### Arrow binding (most common mistake)
- **Always bind arrows** via `startElementId`/`endElementId` referring to shape ids you set.
- **Do not** compute arrow start/end coordinates manually — Excalidraw auto-routes to edges.
- Example:
  ```json
  {
    "elements": [
      {"type": "rectangle", "id": "auth", "x": 100, "y": 100, "width": 160, "height": 80, "text": "Auth Service"},
      {"type": "rectangle", "id": "db", "x": 400, "y": 100, "width": 160, "height": 80, "text": "User DB"},
      {"type": "arrow", "x": 0, "y": 0, "startElementId": "auth", "endElementId": "db", "text": "queries"}
    ]
  }
  ```

### Text on shapes
- Pass `text: "label"` directly on shape — server converts to Excalidraw label format.
- Don't manually wrap as `{label: {text: "..."}}` from MCP side; the server does it.

### fontFamily
- If you set it, pass a string ("1", "2", "3", etc.) or omit. Numbers can fail validation.

### Sizing minimums
- Shapes: width >= 120, height >= 60
- Fonts: body >= 16, titles >= 20, labels >= 14
- Arrow length: >= 80 between connected shapes

### Spacing
- 40-80px gap between adjacent shapes
- Top-to-bottom or left-to-right flow direction
- Use background rectangles as zones for grouping

## See also

- `references/cheatsheet.md` — color palette, common element shapes, arrow patterns
