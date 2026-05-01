import { describe, it, expect } from 'bun:test';
import { normalizeFontFamily, generateId } from './types.js';

describe('normalizeFontFamily', () => {
  it('returns undefined for undefined input', () => {
    expect(normalizeFontFamily(undefined)).toBeUndefined();
  });

  it('passes through numeric input unchanged', () => {
    expect(normalizeFontFamily(1)).toBe(1);
    expect(normalizeFontFamily(5)).toBe(5);
  });

  it('maps common aliases to numeric ids', () => {
    expect(normalizeFontFamily('virgil')).toBe(1);
    expect(normalizeFontFamily('hand')).toBe(1);
    expect(normalizeFontFamily('handwritten')).toBe(1);
    expect(normalizeFontFamily('helvetica')).toBe(2);
    expect(normalizeFontFamily('sans')).toBe(2);
    expect(normalizeFontFamily('cascadia')).toBe(3);
    expect(normalizeFontFamily('mono')).toBe(3);
    expect(normalizeFontFamily('excalifont')).toBe(5);
    expect(normalizeFontFamily('nunito')).toBe(6);
    expect(normalizeFontFamily('lilita')).toBe(7);
    expect(normalizeFontFamily('comic')).toBe(8);
  });

  it('accepts numeric string inputs', () => {
    expect(normalizeFontFamily('1')).toBe(1);
    expect(normalizeFontFamily('2')).toBe(2);
    expect(normalizeFontFamily('5')).toBe(5);
  });

  it('is case-insensitive', () => {
    expect(normalizeFontFamily('VIRGIL')).toBe(1);
    expect(normalizeFontFamily('Helvetica')).toBe(2);
  });

  it('returns undefined for unknown names', () => {
    expect(normalizeFontFamily('comic sans')).toBeUndefined();
    expect(normalizeFontFamily('papyrus')).toBeUndefined();
    expect(normalizeFontFamily('99')).toBeUndefined();
  });
});

describe('generateId', () => {
  it('returns a non-empty string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('returns different ids on consecutive calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(generateId());
    expect(ids.size).toBe(100);
  });
});
