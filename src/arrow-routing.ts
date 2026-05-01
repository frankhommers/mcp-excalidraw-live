// Pure helpers to route arrows from shape edge to shape edge.
// Extracted so they can be unit-tested without booting the express/ws stack.

export interface ShapeLike {
  id: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  boundElements?: Array<{ id: string; type: string }> | null;
}

export interface ArrowLike {
  id: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  start?: { id: string };
  end?: { id: string };
  startBinding?: { elementId: string; focus: number; gap: number };
  endBinding?: { elementId: string; focus: number; gap: number };
  points?: number[][];
}

const GAP = 8;

// Compute the point on the shape's edge that lies on the line from the shape
// center toward (targetCenterX, targetCenterY). Used so arrows touch shape
// borders instead of crossing into them.
export function computeEdgePoint(
  el: ShapeLike,
  targetCenterX: number,
  targetCenterY: number
): { x: number; y: number } {
  const cx = (el.x ?? 0) + (el.width ?? 0) / 2;
  const cy = (el.y ?? 0) + (el.height ?? 0) / 2;
  const dx = targetCenterX - cx;
  const dy = targetCenterY - cy;
  const hw = (el.width ?? 0) / 2;
  const hh = (el.height ?? 0) / 2;

  if (el.type === 'diamond') {
    if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const denom = absDx / hw + absDy / hh;
    const scale = denom > 0 ? 1 / denom : 1;
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  if (el.type === 'ellipse') {
    if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
    const angle = Math.atan2(dy, dx);
    return { x: cx + hw * Math.cos(angle), y: cy + hh * Math.sin(angle) };
  }

  // Rectangle (default)
  if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
  const angle = Math.atan2(dy, dx);
  const tanA = Math.tan(angle);
  if (Math.abs(tanA * hw) <= hh) {
    const signX = dx >= 0 ? 1 : -1;
    return { x: cx + signX * hw, y: cy + signX * hw * tanA };
  } else {
    const signY = dy >= 0 ? 1 : -1;
    return { x: cx + signY * hh / tanA, y: cy + signY * hh };
  }
}

// Mutate arrow elements in `batchElements` so they route edge-to-edge between
// the shapes referenced by their `start.id` / `end.id`. Sets startBinding,
// endBinding, x, y, width, height, points. Updates boundElements on referenced
// shapes (in batch or in `existingElements`) to include this arrow.
//
// Returns nothing; mutates in place. `existingElements` allows arrows to bind
// to shapes already on the canvas, not just shapes in the same batch.
export function resolveArrowBindings(
  batchElements: ArrowLike[],
  existingElements: Map<string, ShapeLike> = new Map()
): void {
  const elementMap = new Map<string, ShapeLike | ArrowLike>(existingElements);
  for (const el of batchElements) elementMap.set(el.id, el);

  for (const el of batchElements) {
    if (el.type !== 'arrow' && el.type !== 'line') continue;
    const startRef = el.start;
    const endRef = el.end;
    if (!startRef && !endRef) continue;

    const startEl = startRef ? (elementMap.get(startRef.id) as ShapeLike | undefined) : undefined;
    const endEl = endRef ? (elementMap.get(endRef.id) as ShapeLike | undefined) : undefined;

    const startCenter = startEl
      ? { x: (startEl.x ?? 0) + (startEl.width ?? 0) / 2, y: (startEl.y ?? 0) + (startEl.height ?? 0) / 2 }
      : { x: el.x ?? 0, y: el.y ?? 0 };
    const endCenter = endEl
      ? { x: (endEl.x ?? 0) + (endEl.width ?? 0) / 2, y: (endEl.y ?? 0) + (endEl.height ?? 0) / 2 }
      : { x: (el.x ?? 0) + 100, y: el.y ?? 0 };

    const startPt = startEl ? computeEdgePoint(startEl, endCenter.x, endCenter.y) : startCenter;
    const endPt = endEl ? computeEdgePoint(endEl, startCenter.x, startCenter.y) : endCenter;

    const dx = endPt.x - startPt.x;
    const dy = endPt.y - startPt.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const finalStart = { x: startPt.x + (dx / dist) * GAP, y: startPt.y + (dy / dist) * GAP };
    const finalEnd = { x: endPt.x - (dx / dist) * GAP, y: endPt.y - (dy / dist) * GAP };

    el.x = finalStart.x;
    el.y = finalStart.y;
    el.width = Math.abs(finalEnd.x - finalStart.x);
    el.height = Math.abs(finalEnd.y - finalStart.y);
    el.points = [[0, 0], [finalEnd.x - finalStart.x, finalEnd.y - finalStart.y]];

    if (startEl) {
      el.startBinding = { elementId: startEl.id, focus: 0, gap: GAP };
      if (!Array.isArray(startEl.boundElements)) startEl.boundElements = [];
      if (!startEl.boundElements.find((b) => b?.id === el.id)) {
        startEl.boundElements.push({ id: el.id, type: 'arrow' });
      }
    }
    if (endEl) {
      el.endBinding = { elementId: endEl.id, focus: 0, gap: GAP };
      if (!Array.isArray(endEl.boundElements)) endEl.boundElements = [];
      if (!endEl.boundElements.find((b) => b?.id === el.id)) {
        endEl.boundElements.push({ id: el.id, type: 'arrow' });
      }
    }
  }
}
