/**
 * The reading styles' wiring, checked in src: the entry stylesheet maps the
 * tokens by name for Tailwind v4, the reading values are our own element rules
 * themed on the tokens (the typography plugin stays pinned for madarch-j0a and
 * contributes no rule to any element today), and the Markdown renderer provides
 * the hooks they scope to (.reading around the document, .table-wrap around each table).
 * The measured pixel numbers are proven by the walk on the served fixture,
 * not here.
 */
import { afterEach, afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { Markdown } from '../view.js';

const here = dirname(fileURLToPath(import.meta.url));
const indexCss = readFileSync(join(here, 'index.css'), 'utf8');
const tokensCss = readFileSync(join(here, 'tokens.css'), 'utf8');

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
});

afterAll(async () => {
  await new Promise((rest) => setTimeout(rest, 50));
  GlobalRegistrator.unregister();
});

let rendered: { root: Root; container: HTMLElement } | undefined;

function unmount(): void {
  rendered?.root.unmount();
  rendered = undefined;
}

afterEach(() => {
  unmount();
});

describe('the entry stylesheet', () => {
  test('runs Tailwind v4; the typography plugin stays pinned though nothing wires its classes in', () => {
    expect(indexCss).toContain('@import "tailwindcss";');
    expect(indexCss).toContain('@plugin "@tailwindcss/typography";');
  });

  test('maps the tokens by name, so the tokens stay the values source', () => {
    expect(indexCss).toContain('@theme inline');
    for (const mapping of [
      '--color-page: var(--bg-page);',
      '--color-chrome: var(--bg-chrome);',
      '--color-ink: var(--text);',
      '--color-secondary: var(--text-secondary);',
      '--color-muted: var(--text-muted);',
      '--color-line: var(--border);',
      '--color-pill: var(--code-bg);',
      '--text-body: var(--fs-body);',
      '--text-title: var(--fs-h1);',
      '--text-small: var(--fs-small);',
    ]) {
      expect(indexCss).toContain(mapping);
    }
    // the breakpoints sit at the accepted widths
    expect(indexCss).toContain('--breakpoint-md: 700px;');
    expect(indexCss).toContain('--breakpoint-wide: 1150px;');
  });

  test('the tokens hold the agreed names the reading rules ride', () => {
    expect(tokensCss).toContain('--fs-body: 18px;');
    expect(tokensCss).toContain('--leading: 1.58;');
    expect(tokensCss).toContain('--measure: 960px;');
    expect(tokensCss).toContain('--fs-h1: var(--fs-title);');
    for (const name of ['--bg-page', '--bg-chrome', '--text', '--text-secondary', '--code-bg', '--border', '--border-subtle', '--quote-border', '--selection']) {
      expect(tokensCss).toContain(name + ':');
      expect(tokensCss.split('@media (prefers-color-scheme: dark)').length).toBeGreaterThanOrEqual(2);
    }
  });

  test('the reading rules carry the accepted selectors and the phone block', () => {
    for (const selector of ['main h1', 'main h2', 'main p', 'main ul,', 'main blockquote', 'main pre', 'main :not(pre) > code', 'main .table-wrap']) {
      expect(indexCss).toContain(selector);
    }
    expect(indexCss).toMatch(/@media \(max-width: 700px\)[\s\S]*min-width: 9em/);
  });

  test('the work area is flush and its text measure is fluid, capped only on wide windows', () => {
    const workArea = indexCss.slice(indexCss.indexOf('.shell-document {'), indexCss.indexOf('}', indexCss.indexOf('.shell-document {')));
    const content = indexCss.slice(indexCss.indexOf('.shell-document > main {'), indexCss.indexOf('}', indexCss.indexOf('.shell-document > main {')));
    expect(workArea).toContain('width: 100%;');
    expect(workArea).toContain('min-block-size: 100%;');
    expect(workArea).toContain('padding: calc(2.5em + 14px) 48px 2.5em;');
    expect(workArea).toContain('overflow-wrap: break-word;');
    expect(workArea).not.toContain('max-inline-size:');
    expect(workArea).not.toContain('margin-inline:');
    expect(workArea).not.toContain('border-radius:');
    expect(workArea).not.toContain('box-shadow:');
    expect(content).toContain('max-inline-size: var(--measure);');
    expect(content).toContain('margin-inline: auto;');
    expect(indexCss).toMatch(/@media \(max-width: 900px\)[\s\S]*?padding-inline: 32px;/);
    expect(indexCss).toMatch(/@media \(max-width: 700px\)[\s\S]*?padding: calc\(2.5em - 8px\) 20px 2.5em;/);
    const scroll = indexCss.slice(indexCss.indexOf('.shell-scroll {'), indexCss.indexOf('}', indexCss.indexOf('.shell-scroll {')));
    expect(scroll).toContain('background: var(--surface-page);');
  });

  test('the paragraph gap is the research value, first paragraph above it keeps 0', () => {
    expect(indexCss).toMatch(/main p \{[\s\S]*?margin-block: 0 0\.95em;/s);
  });

  test('the lead: the document opening paragraph stands in the secondary colour, one step up', () => {
    expect(indexCss).toContain('.reading > p:first-child,\n.reading > h1:first-child + p {');
    const block = indexCss.slice(indexCss.indexOf('.reading > p:first-child,\n.reading > h1:first-child + p {'));
    expect(block).toContain('color: var(--text-secondary);');
    expect(block).toContain('font-size: 1em;');
  });

  test('the app fallback title hides when the document renders its own first heading', () => {
    expect(indexCss).toContain('.shell:has(.reading > h1:first-child) main > .app-title {');
  });

  test('the page h1 rides the title token', () => {
    expect(indexCss).toMatch(/\.reading > h1 \{[\s\S]*?font-size: var\(--fs-h1\);/s);
  });

  test('a long word wraps inside the column, never the page', () => {
    expect(indexCss).toMatch(/\.shell-document \{[\s\S]*overflow-wrap: break-word;/s);
  });

  test('home overview groups fill the text measure with a rounded hairline, no cards cast a shadow', () => {
    const group = indexCss.slice(indexCss.indexOf('.home-group {'), indexCss.indexOf('}', indexCss.indexOf('.home-group {')));
    expect(group).toContain('border: 1px solid var(--border-subtle);');
    expect(group).toContain('border-radius: var(--radius-card);');
    expect(group).not.toContain('box-shadow:');
    expect(indexCss).toContain('.shell-document > main {');
    expect(indexCss).toContain('max-inline-size: var(--measure);');
  });

  test('home overview rows are not underlined by the document-link rule', () => {
    const row = indexCss.slice(indexCss.indexOf('.home-row {'), indexCss.indexOf('}', indexCss.indexOf('.home-row {')));
    expect(row).toContain('border-block-end: none;');
    expect(indexCss).toContain('.home-row:hover {');
    expect(indexCss).toContain('background: var(--surface-hover);');
    expect(indexCss).toContain('main a {');
    expect(indexCss).toContain('border-block-end: 1px solid var(--link-underline);');
  });

  test('the table scrolls in its own wrap and phone cells hold the 9em minimum', () => {
    expect(indexCss).toMatch(/main \.table-wrap \{[\s\S]*overflow: auto;/s);
    expect(indexCss).toMatch(/@media \(max-width: 700px\)[\s\S]*main \.table-wrap th,\s*main \.table-wrap td \{[\s\S]*min-width: 9em;/s);
  });
});

describe('the Markdown hooks the reading rules scope to', () => {
  test('the document stands inside .reading', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rendered = { root, container };
    root.render(createElement(Markdown, { text: 'Hello' }));
    for (let i = 0; i < 200; i++) {
      if (container.querySelector('.reading') !== null) break;
      await new Promise((step) => setTimeout(step, 10));
    }
    const reading = container.querySelector('.reading');
    expect(reading).not.toBeNull();
    expect(reading?.textContent).toBe('Hello');
  });

  test('a table stands inside .table-wrap, its own scroll container', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rendered = { root, container };
    root.render(
      createElement(Markdown, {
        text: '| A | B |\n| --- | --- |\n| 1 | 2 |',
      }),
    );
    for (let i = 0; i < 200; i++) {
      if (container.querySelector('.table-wrap') !== null) break;
      await new Promise((step) => setTimeout(step, 10));
    }
    const wrap = container.querySelector('.table-wrap');
    expect(wrap).not.toBeNull();
    expect(wrap?.querySelector('table')).not.toBeNull();
  });
});
