import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { architectureCheck, architectureCheckPasses, architectureProblemLines, renderViolationListOf } from '../scripts/check/architecture/check.js';
const RULE = 'read-no-judgements' as const;
const targets = ['disputes', 'assertion-selection'];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'madarch-read-rule-'));
  for (const [file, text] of Object.entries({
    'package.json': '{"type":"module"}',
    '.architecture/violations.json': '[]',
    ...Object.fromEntries(targets.map(name => [`src/graph/${name}.ts`, 'export const judge = 1;'])),
    ...files,
  })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const check = (root: string) => architectureCheck({ root, rules: [RULE] });

describe('read code never imports writer judgements (0039 amendment)', () => {
  test('knowledge, GraphQL and MCP imports fail with full paths and lines', async () => {
    const readers = ['knowledge/nested/read', 'graphql/schema', 'mcp/authored', 'graph/graphql-read', 'graph/graphql-execute'];
    const files = Object.fromEntries(readers.map(file => [`src/${file}.ts`, `// preface
import { judge } from '${file.startsWith('knowledge/nested/') ? '../../graph/' : file.startsWith('graph/') ? './' : '../graph/'}disputes.js';
import type { judge as selection } from '${file.startsWith('knowledge/nested/') ? '../../graph/' : file.startsWith('graph/') ? './' : '../graph/'}assertion-selection.js';`]));
    const root = fixture(files);
    try {
      const report = await check(root);
      expect(report.found).toEqual(readers.map(file => `src/${file}.ts`).sort().flatMap(file => [
        { rule: RULE, file, line: 3, symbol: 'src/graph/assertion-selection.ts' },
        { rule: RULE, file, line: 2, symbol: 'src/graph/disputes.ts' },
      ]));
      expect(architectureCheckPasses(report)).toBe(false);
      for (const found of report.found) expect(architectureProblemLines(report)).toContainEqual(expect.stringContaining(`${join(root, found.file)}:${found.line}: ${RULE}:`));
      expect(renderViolationListOf(report)).toBe('[]\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('re-exports, namespace, side-effect and dynamic imports also fail', async () => {
    const statements = [
      "export { judge } from '../graph/disputes.js';",
      "export * from '../graph/disputes.js';",
      "import * as writer from '../graph/disputes.js';",
      "import '../graph/disputes.js';",
      "const writer = await import('../graph/disputes.js');",
    ];
    const root = fixture(Object.fromEntries(statements.map((text, index) => [`src/knowledge/read-${index}.ts`, `// preface
${text}`])));
    try {
      expect((await check(root)).found).toEqual(statements.map((_, index) => ({ rule: RULE, file: `src/knowledge/read-${index}.ts`, line: 2, symbol: 'src/graph/disputes.ts' })));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('writers may import judgements and readers may import ordinary read APIs', async () => {
    const root = fixture({
      'src/graph/write.ts': "import './disputes.js'; import './assertion-selection.js';",
      'src/graph/assertion-read.ts': 'export const read = 1;',
      'src/knowledge/read.ts': "import '../graph/assertion-read.js';",
      'src/graphql/schema.ts': "import '../graph/assertion-read.js';",
      'src/mcp/authored.ts': "import '../graph/assertion-read.js';",
    });
    try { expect(architectureCheckPasses(await check(root))).toBe(true); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('debt cannot excuse a read-time judgement', async () => {
    const root = fixture({
      'src/knowledge/read.ts': "import '../graph/disputes.js';",
      '.architecture/violations.json': JSON.stringify([{ rule: RULE, file: 'src/knowledge/read.ts', symbol: 'src/graph/disputes.ts' }]),
    });
    try {
      const report = await check(root);
      expect(report.noBaseline).toHaveLength(1);
      expect(architectureCheckPasses(report)).toBe(false);
      expect(renderViolationListOf(report)).toBe('[]\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
