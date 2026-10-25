import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('the wiki declares one self-contained SVG favicon without an external icon request', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const icons = [...html.matchAll(/<link\b[^>]*\brel="icon"[^>]*>/g)];
  expect(icons).toHaveLength(1);
  expect(icons[0]![0]).toContain('type="image/svg+xml"');
  const href = /\bhref="([^"]+)"/.exec(icons[0]![0])![1]!;
  expect(href.startsWith('data:image/svg+xml,')).toBe(true);
  const svg = decodeURIComponent(href.slice('data:image/svg+xml,'.length));
  expect(svg.startsWith('<svg ')).toBe(true);
  expect(svg.endsWith('</svg>')).toBe(true);
  expect(svg).not.toMatch(/<(?:image|script|use)\b|\b(?:href|src)=/);
});
