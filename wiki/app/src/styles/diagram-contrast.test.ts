/**
 * The diagram palette's contrast (madarch-64o5.96): every renderer draws node labels, edge labels and the focus node
 * from the kit's tokens of the scheme, so the pairs are computed here from tokens.css itself and held to WCAG AA (4.5:1
 * for text). A scheme whose token pair drops under it fails this test, not a walk.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** One colour as red, green, blue and alpha (0–255, alpha 0–1), from `rgb()`, `rgba()` or `#rgb[a]`/`#rrggbb[aa]`. */
function colourOf(value: string): { r: number; g: number; b: number; a: number } | undefined {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/iu.exec(text);
  if (hex !== null) {
    const digits = hex[1]!;
    const at = (start: number, length: number): number => parseInt(digits.slice(start, start + length), 16);
    if (digits.length === 3 || digits.length === 4) return { r: at(0, 1) * 17, g: at(1, 1) * 17, b: at(2, 1) * 17, a: digits.length === 4 ? (at(3, 1) * 17) / 255 : 1 };
    if (digits.length === 6 || digits.length === 8) return { r: at(0, 2), g: at(2, 2), b: at(4, 2), a: digits.length === 8 ? at(6, 2) / 255 : 1 };
    return undefined;
  }
  const rgba = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/iu.exec(text);
  if (rgba === null) return undefined;
  return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: rgba[4] === undefined ? 1 : Number(rgba[4]) };
}

/** A colour laid over an opaque ground, the way a translucent token paints. */
function over(value: string, ground: string): { r: number; g: number; b: number } | undefined {
  const top = colourOf(value);
  const under = colourOf(ground);
  if (top === undefined || under === undefined) return undefined;
  const mix = (one: number, two: number): number => Math.round(one * top.a + two * (1 - top.a));
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b) };
}

/** The relative luminance of a colour. */
function luminance(colour: { r: number; g: number; b: number }): number {
  const channel = (value: number): number => {
    const held = value / 255;
    return held <= 0.03928 ? held / 12.92 : ((held + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b);
}

/** WCAG 2.1 contrast between two opaque colours; 1–21. */
function contrastRatio(first: { r: number; g: number; b: number }, second: { r: number; g: number; b: number }): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const tokensCss = readFileSync(join(here, 'tokens.css'), 'utf8');

/** The variables a CSS block sets, as name → value. */
function variablesOf(block: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gu)) found[match[1]!] = match[2]!.trim();
  return found;
}

/** The light block (the first `:root`) and the dark block (inside the media query). */
function schemes(): { light: Record<string, string>; dark: Record<string, string> } {
  const darkAt = tokensCss.indexOf('@media (prefers-color-scheme: dark)');
  const light = variablesOf(tokensCss.slice(0, darkAt < 0 ? tokensCss.length : darkAt));
  const dark = variablesOf(darkAt < 0 ? '' : tokensCss.slice(darkAt));
  return { light, dark };
}

/** The palette the renderers are handed, in one scheme. */
function palette(vars: Record<string, string>): { canvas: string; nodeFill: string; nodeText: string; edgeLabelBg: string; focusFill: string } {
  const resolve = (name: string): string => {
    let value = vars[name] ?? '';
    for (let at = 0; at < 8 && /^var\((--[a-z0-9-]+)\)$/u.test(value); at += 1) value = vars[/^var\((--[a-z0-9-]+)\)$/u.exec(value)![1]!] ?? value;
    return value;
  };
  return { canvas: resolve('--surface-page'), nodeFill: resolve('--surface-active'), nodeText: resolve('--text'), edgeLabelBg: resolve('--surface-card'), focusFill: resolve('--surface-soft') };
}

/** A colour's WCAG contrast against a token that may be translucent, laid over the canvas the way it paints. */
function ratio(text: string, ground: string, canvas: string): number {
  const laid = over(ground, canvas)!;
  return contrastRatio(colourOf(text)!, laid);
}

describe('the diagram palette holds AA contrast in both schemes', () => {
  for (const [scheme, vars] of Object.entries(schemes())) {
    test(`${scheme}: a node's label reads against its node, an edge label against its chip, the focus node against its fill`, () => {
      const held = palette(vars);
      for (const [what, ground] of [['node', held.nodeFill], ['edge label', held.edgeLabelBg], ['focus node', held.focusFill]] as const) {
        const value = ratio(held.nodeText, ground, held.canvas);
        expect({ scheme, what, contrast: value }).toMatchObject({ contrast: expect.any(Number) });
        expect(value, `${scheme} ${what}: ${held.nodeText} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  test('the palette names every token the renderers are handed', () => {
    const { light } = schemes();
    for (const name of ['--surface-page', '--surface-active', '--surface-card', '--surface-soft', '--text', '--text-muted', '--border']) {
      expect(light[name], name).toBeDefined();
    }
  });
});
