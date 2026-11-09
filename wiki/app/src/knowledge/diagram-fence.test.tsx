/**
 * The ```mermaid fence in a document (madarch-u3vw.18): the language the
 * Markdown parser put on the code node decides — never a look at the text —
 * and a Mermaid fence is drawn by the wiki's own renderer (../diagram.js, the
 * pinned mermaid and the reader's colour scheme) under a Diagram / Source
 * switch. A fence that cannot be drawn names the document and the line its
 * opening stands on; every other fence stays the code block it was.
 *
 * happy-dom has no layout: the pinned renderer measures its labels through
 * getBBox, which answers an empty box there. The test gives every svg graphics
 * element a box, so the renderer completes as it does in a browser; the
 * picture itself is read from the shots, not here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { KMarkdown } from './blocks.js';
import { fenceLanguage, mermaidFence } from './diagram-fence.js';

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.defineProperty(SVGGraphicsElement.prototype, 'getBBox', {
    configurable: true,
    value: () => new DOMRect(0, 0, 60, 16),
  });
  await setWikiLanguage('en');
});

afterAll(async () => {
  await new Promise((rest) => setTimeout(rest, 50));
  GlobalRegistrator.unregister();
});

let rendered: Root | undefined;
function into(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  rendered = createRoot(container);
  rendered.render(element);
  return container;
}

async function until(holds: () => boolean | undefined, what: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (holds()) return;
    await new Promise((step) => setTimeout(step, 10));
  }
  throw new Error(`never came to ${what}; the tree holds: ${document.body.innerHTML.slice(0, 2000)}`);
}

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = '';
});

/** A document whose fences are an erDiagram, a flowchart, a broken erDiagram and a ts block; the line each opening stands on is found, not counted. */
const DOC = [
  '# The database',
  '',
  '```mermaid',
  'erDiagram',
  '  orders ||--o{ lines : holds',
  '  orders {',
  '    uuid id PK',
  '  }',
  '```',
  '',
  'A flowchart:',
  '',
  '```mermaid',
  'flowchart LR',
  '  orders --> lines',
  '```',
  '',
  '```mermaid',
  'erDiagram',
  '  orders {{{ not a table',
  '```',
  '',
  '```ts',
  'const mermaid = 1;',
  '```',
].join('\n');
const lineOf = (text: string): number => DOC.slice(0, DOC.indexOf(text)).split('\n').length;
const ER_LINE = lineOf('```mermaid\nerDiagram\n  orders ||--o{ lines');
const FLOW_LINE = lineOf('```mermaid\nflowchart LR');
const BROKEN_LINE = lineOf('```mermaid\nerDiagram\n  orders {{{');

describe('what a fence is', () => {
  test('the parser\'s code language decides, so a code text that mentions mermaid is still code', () => {
    const pre = (language: string, text: string) => ({ tagName: 'pre', position: { start: { line: 4 } }, children: [{ tagName: 'code', properties: { className: ['language-' + language] }, children: [{ type: 'text', value: text }] }] });
    expect(fenceLanguage(pre('mermaid', 'flowchart LR\n  a --> b\n'))).toBe('mermaid');
    expect(fenceLanguage(pre('ts', 'const mermaid = 1;'))).toBe('ts');
    expect(mermaidFence(pre('ts', '```mermaid\nflowchart LR\n```'))).toBeNull();
    expect(mermaidFence(pre('mermaid', 'flowchart LR\n  a --> b\n'))).toEqual({ source: 'flowchart LR\n  a --> b\n', line: 4 });
    expect(fenceLanguage({ tagName: 'p' })).toBeNull();
  });
});

describe('a Mermaid fence in a document', () => {
  test('the erDiagram and the flowchart are drawn by the wiki\'s Mermaid, the broken fence names the document and its line, and the ts fence stays code', async () => {
    const container = into(createElement(KMarkdown, { text: DOC, resolutions: {}, inDocument: { repo: null, path: 'docs/database.md' } }));
    await until(() => container.querySelectorAll('[data-testid=mermaid-fence]').length === 3, 'three Mermaid fences');
    const fences = [...container.querySelectorAll<HTMLElement>('[data-testid=mermaid-fence]')];
    expect(fences.map((fence) => fence.getAttribute('data-fence-line'))).toEqual([String(ER_LINE), String(FLOW_LINE), String(BROKEN_LINE)]);
    // The two good fences are drawn; the broken one says where it stands and why.
    await until(() => container.querySelector('[data-testid=mermaid-error]') !== null, 'the broken fence\'s error');
    await until(() => container.querySelectorAll('[data-testid=mermaid-fence] [data-testid=mermaid-diagram]').length === 2, 'the two drawn fences');
    expect(container.querySelectorAll('[data-testid=mermaid-fence] [data-testid=mermaid-error]')).toHaveLength(1);
    const error = container.querySelector('[data-testid=mermaid-error]')!;
    expect(error.textContent).toContain(`docs/database.md:${BROKEN_LINE}`);
    expect(error.textContent).toContain('Parse error');
    // Every other fence stays the code block it was, and a code text naming mermaid draws nothing.
    const pres = [...container.querySelectorAll('pre')];
    expect(pres).toHaveLength(1);
    expect(pres[0]!.textContent).toBe('const mermaid = 1;\n');
    expect(container.querySelector('pre code')!.getAttribute('class')).toBe('language-ts');
  });

  test('the Diagram / Source switch shows the fence\'s own source and the diagram again', async () => {
    const container = into(createElement(KMarkdown, { text: DOC, resolutions: {}, inDocument: { repo: null, path: 'docs/database.md' } }));
    await until(() => container.querySelectorAll('[data-testid=mermaid-fence]').length === 3, 'three Mermaid fences');
    const first = container.querySelector<HTMLElement>('[data-testid=mermaid-fence]')!;
    const sourceTab = first.querySelector<HTMLButtonElement>('[data-testid=fence-source-tab]')!;
    expect(sourceTab.getAttribute('aria-selected')).toBe('false');
    sourceTab.click();
    await until(() => first.querySelector('[data-testid=fence-source]') !== null, 'the fence source');
    expect(first.querySelector('[data-testid=fence-source]')!.textContent).toBe('erDiagram\n  orders ||--o{ lines : holds\n  orders {\n    uuid id PK\n  }\n');
    expect(first.querySelector('[data-testid=mermaid-diagram]')).toBeNull();
    expect(sourceTab.getAttribute('aria-selected')).toBe('true');
    first.querySelector<HTMLButtonElement>('[data-testid=fence-diagram-tab]')!.click();
    await until(() => first.querySelector('[data-testid=mermaid-diagram]') !== null, 'the diagram again');
    expect(first.querySelector('[data-testid=fence-source]')).toBeNull();
  });

  test('a text whose file is named apart from a document page still names it in the failure', async () => {
    const container = into(createElement(KMarkdown, { text: DOC, resolutions: {}, sourcePath: 'docs/from-a-page.md' }));
    await until(() => container.querySelector('[data-testid=mermaid-error]') !== null, 'the broken fence\'s error');
    expect(container.querySelector('[data-testid=mermaid-error]')!.textContent).toContain(`docs/from-a-page.md:${BROKEN_LINE}`);
  });
});
