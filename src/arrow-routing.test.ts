import { describe, it, expect } from 'bun:test';
import { computeEdgePoint, resolveArrowBindings, type ShapeLike, type ArrowLike } from './arrow-routing.js';

describe('computeEdgePoint', () => {
  describe('rectangle', () => {
    const rect: ShapeLike = { id: 'r', type: 'rectangle', x: 100, y: 100, width: 100, height: 50 };
    // center = (150, 125)

    it('intersects right edge when target is directly to the right', () => {
      const p = computeEdgePoint(rect, 500, 125);
      expect(p.x).toBeCloseTo(200);
      expect(p.y).toBeCloseTo(125);
    });

    it('intersects left edge when target is directly to the left', () => {
      const p = computeEdgePoint(rect, -500, 125);
      expect(p.x).toBeCloseTo(100);
      expect(p.y).toBeCloseTo(125);
    });

    it('intersects top edge when target is above and far away', () => {
      const p = computeEdgePoint(rect, 150, -1000);
      expect(p.x).toBeCloseTo(150);
      expect(p.y).toBeCloseTo(100);
    });

    it('intersects bottom edge when target is below and far away', () => {
      const p = computeEdgePoint(rect, 150, 5000);
      expect(p.x).toBeCloseTo(150);
      expect(p.y).toBeCloseTo(150);
    });

    it('returns bottom of shape when target equals center (degenerate)', () => {
      const p = computeEdgePoint(rect, 150, 125);
      expect(p.x).toBeCloseTo(150);
      expect(p.y).toBeCloseTo(150); // cy + hh
    });
  });

  describe('ellipse', () => {
    const ell: ShapeLike = { id: 'e', type: 'ellipse', x: 0, y: 0, width: 100, height: 100 };
    // circle of radius 50 centered at (50, 50)

    it('returns point on circle for east direction', () => {
      const p = computeEdgePoint(ell, 1000, 50);
      expect(p.x).toBeCloseTo(100);
      expect(p.y).toBeCloseTo(50);
    });

    it('returns point on circle for north direction', () => {
      const p = computeEdgePoint(ell, 50, -1000);
      expect(p.x).toBeCloseTo(50);
      expect(p.y).toBeCloseTo(0);
    });

    it('respects ellipse aspect for non-circular shapes', () => {
      const wide: ShapeLike = { id: 'w', type: 'ellipse', x: 0, y: 0, width: 200, height: 100 };
      // semi-axes a=100 (x), b=50 (y); angle 0 (east) -> (100 + 100, 50)
      const p = computeEdgePoint(wide, 5000, 50);
      expect(p.x).toBeCloseTo(200);
      expect(p.y).toBeCloseTo(50);
    });
  });

  describe('diamond', () => {
    const d: ShapeLike = { id: 'd', type: 'diamond', x: 0, y: 0, width: 100, height: 100 };
    // diamond inscribed in 100x100 box, centered at (50, 50), tips at (50,0),(100,50),(50,100),(0,50)

    it('hits east tip when going right', () => {
      const p = computeEdgePoint(d, 1000, 50);
      expect(p.x).toBeCloseTo(100);
      expect(p.y).toBeCloseTo(50);
    });

    it('hits north tip when going up', () => {
      const p = computeEdgePoint(d, 50, -1000);
      expect(p.x).toBeCloseTo(50);
      expect(p.y).toBeCloseTo(0);
    });
  });
});

describe('resolveArrowBindings', () => {
  it('routes arrow from rect A to rect B with start/end refs', () => {
    const a: ShapeLike = { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 };
    const b: ShapeLike = { id: 'b', type: 'rectangle', x: 300, y: 0, width: 100, height: 100 };
    const arrow: ArrowLike = { id: 'arr', type: 'arrow', start: { id: 'a' }, end: { id: 'b' } };
    resolveArrowBindings([a, b, arrow]);

    // Arrow should now have bindings + position
    expect(arrow.startBinding).toBeDefined();
    expect(arrow.startBinding!.elementId).toBe('a');
    expect(arrow.endBinding).toBeDefined();
    expect(arrow.endBinding!.elementId).toBe('b');

    // Position is somewhere between the two shapes
    expect(arrow.x).toBeGreaterThan(50); // past right edge of A (100) minus gap
    expect(arrow.x).toBeLessThan(300);   // before left edge of B
    expect(arrow.points).toHaveLength(2);
  });

  it('marks both shapes as having the arrow in boundElements', () => {
    const a: ShapeLike = { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 };
    const b: ShapeLike = { id: 'b', type: 'rectangle', x: 300, y: 0, width: 100, height: 100 };
    const arrow: ArrowLike = { id: 'arr', type: 'arrow', start: { id: 'a' }, end: { id: 'b' } };
    resolveArrowBindings([a, b, arrow]);

    expect(a.boundElements).toEqual([{ id: 'arr', type: 'arrow' }]);
    expect(b.boundElements).toEqual([{ id: 'arr', type: 'arrow' }]);
  });

  it('skips arrows without start or end refs', () => {
    const arrow: ArrowLike = { id: 'arr', type: 'arrow', x: 10, y: 20 };
    const before = JSON.stringify(arrow);
    resolveArrowBindings([arrow]);
    expect(JSON.stringify(arrow)).toBe(before);
  });

  it('binds to existing canvas element when not in batch', () => {
    const existing: ShapeLike = { id: 'old', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 };
    const map = new Map<string, ShapeLike>([[existing.id, existing]]);
    const newShape: ShapeLike = { id: 'new', type: 'rectangle', x: 300, y: 0, width: 100, height: 100 };
    const arrow: ArrowLike = { id: 'arr', type: 'arrow', start: { id: 'old' }, end: { id: 'new' } };
    resolveArrowBindings([newShape, arrow], map);

    expect(arrow.startBinding!.elementId).toBe('old');
    expect(arrow.endBinding!.elementId).toBe('new');
    expect(existing.boundElements).toEqual([{ id: 'arr', type: 'arrow' }]);
    expect(newShape.boundElements).toEqual([{ id: 'arr', type: 'arrow' }]);
  });

  it('does not duplicate boundElements entries when arrow re-resolved', () => {
    const a: ShapeLike = { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 100, boundElements: [{ id: 'arr', type: 'arrow' }] };
    const b: ShapeLike = { id: 'b', type: 'rectangle', x: 300, y: 0, width: 100, height: 100 };
    const arrow: ArrowLike = { id: 'arr', type: 'arrow', start: { id: 'a' }, end: { id: 'b' } };
    resolveArrowBindings([a, b, arrow]);
    expect(a.boundElements).toEqual([{ id: 'arr', type: 'arrow' }]);
  });
});
