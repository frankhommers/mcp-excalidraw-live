# Excalidraw Cheatsheet

## Color palette

### Stroke colors (borders + text)
| Name   | Hex     | Use                     |
|--------|---------|-------------------------|
| Black  | #1e1e1e | Default text + borders  |
| Red    | #e03131 | Errors, critical        |
| Green  | #2f9e44 | Success, healthy        |
| Blue   | #1971c2 | Primary, links          |
| Purple | #9c36b5 | Services, middleware    |
| Orange | #e8590c | Async, queues, events   |
| Cyan   | #0c8599 | Data stores             |
| Gray   | #868e96 | Annotations             |

### Fill colors (backgroundColor) — pastels
| Name        | Hex     | Pairs with |
|-------------|---------|------------|
| LightRed    | #ffc9c9 | #e03131    |
| LightGreen  | #b2f2bb | #2f9e44    |
| LightBlue   | #a5d8ff | #1971c2    |
| LightPurple | #eebefa | #9c36b5    |
| LightOrange | #ffd8a8 | #e8590c    |
| LightCyan   | #99e9f2 | #0c8599    |
| LightGray   | #e9ecef | #868e96    |

## Element types
- `rectangle`, `ellipse`, `diamond` — shapes (need width + height)
- `arrow`, `line` — connectors (use points or bind via startElementId/endElementId)
- `text` — standalone text
- `freedraw` — sketched line

## Patterns

### Box with label
```json
{"type": "rectangle", "id": "auth", "x": 100, "y": 100,
 "width": 160, "height": 80,
 "backgroundColor": "#a5d8ff", "strokeColor": "#1971c2",
 "text": "Auth Service"}
```

### Bound arrow (auto-routed edge to edge)
```json
{"type": "arrow", "x": 0, "y": 0,
 "startElementId": "auth", "endElementId": "db",
 "text": "HTTP"}
```

### Dashed arrow (async/optional)
```json
{"type": "arrow", "x": 0, "y": 0,
 "startElementId": "service", "endElementId": "queue",
 "strokeStyle": "dashed", "text": "publishes"}
```

### Zone background (group of related shapes)
Place a large light-fill rectangle BEFORE other elements (z-order = creation order):
```json
{"type": "rectangle", "x": 80, "y": 80,
 "width": 600, "height": 300,
 "backgroundColor": "#e9ecef", "strokeColor": "#868e96",
 "strokeStyle": "dashed",
 "text": "Backend Services"}
```

### Standalone text annotation
```json
{"type": "text", "x": 200, "y": 50,
 "text": "v3 Architecture",
 "fontSize": 24, "strokeColor": "#1e1e1e"}
```

## Anti-patterns to avoid
1. **Manual arrow coordinates** — always use startElementId/endElementId binding instead.
2. **Overlapping shapes** — leave 40-80px gaps.
3. **Tiny fonts** — never below 14px.
4. **Too many colors** — 3-4 fill colors per diagram max.
5. **Unlabeled shapes** — every shape and meaningful arrow needs text.
6. **Computing centers manually** — use `align_elements` and `distribute_elements`.

## Workflow tips
- Snapshot before risky changes: `snapshot_scene("v1")`.
- Look at your work: `export_canvas(format: "png")` returns visible image.
- `describe_scene` is faster than PNG when you only need positions.
- Set viewport: `set_viewport({scrollToContent: true})` after big creates so the human sees the work.
