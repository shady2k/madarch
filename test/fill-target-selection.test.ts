import { expect, test } from 'bun:test';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { fillTargets } from '../src/knowledge/fill-targets.js';

const text = `kinds:
  source:
    source: graph
    template: templates/source.md
    derives-from: []
  summary:
    source: graph
    template: templates/summary.md
    derives-from: [source]
  report:
    source: graph
    template: templates/report.md
    derives-from: [summary]
`;

test('selection fills only requested kinds and transitive prerequisites', () => {
  const parsed = parseKinds(text, '/fixture/madarch/kinds.yaml', '/fixture', { has: (path) => path.startsWith('templates/'), text: (path) => path.startsWith('templates/') ? '# Template' : undefined, size: () => 10 });
  expect(parsed.findings).toEqual([]);
  const answer = fillTargets(parsed, ['summary']);
  expect(answer.ok).toBe(true);
  if (answer.ok) expect(answer.targets.order).toEqual(['source', 'summary']);
});


test('the replaced depends-on field refuses with its declaration location', () => {
  const parsed = parseKinds(text.replaceAll('derives-from', 'depends-on'), '/fixture/madarch/kinds.yaml', '/fixture', { has: (path) => path.startsWith('templates/'), text: (path) => path.startsWith('templates/') ? '# Template' : undefined, size: () => 10 });
  expect(parsed.findings.some((finding) => finding.file === '/fixture/madarch/kinds.yaml' && finding.line === 5 && finding.message.includes('depends-on'))).toBe(true);
});
