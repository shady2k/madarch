/** The index consumes complete producer opinions, never Markdown syntax. */
import { expect, test } from 'bun:test';
import { graphKnowledgePages } from '../src/knowledge/index/index.js';
import type { KindsManifest } from '../src/product/manifest/kinds.js';
import type { GraphReader } from '../src/knowledge/graph-read.js';

const manifest = { file: 'madarch/kinds.yaml', kinds: new Map([['domain', { name: 'domain', fields: [{ name: 'body' }] }]]) } as unknown as KindsManifest;
const graph = (properties: Record<string, unknown>): Pick<GraphReader, 'list'> => ({ list: async () => ({ rows: [{ key: 'domain:payments', kind: 'domain', label: 'Payments', properties, nodeIds: [], scope: '' }], next: null, total: 1 }) }) as Pick<GraphReader, 'list'>;

test('page identity, written basis, statements, grounds and mentions remain the producer opinions', async () => {
  const statement = { id: 'charge', labels: ['charge', 'policy'], text: 'Payments are charged.', digest: 'sentence', line: 18, mentions: ['domain:ordering'], grounds: ['code.service:payments', 'doc:docs/rules.md#br-4'] };
  const basis = [{ repository: 'training', commit: '0123456789abcdef', branch: 'main', origin: 'https://example.test/shop.git' }];
  const result = await graphKnowledgePages(graph({ body: 'opaque producer body', file: 'docs/payments.md', relates: ['code.service:payments'], sources: ['docs/rules.md'], 'written-at': basis, statements: [statement], mentions: ['domain:ordering'], digest: 'page', producer: 'agent' }), manifest);
  expect(result.pages).toEqual([{ id: 'domain:payments', kind: 'domain', title: 'Payments', file: 'docs/payments.md', relates: ['code.service:payments'], sources: ['docs/rules.md'], writtenAt: basis, statements: [statement], mentions: ['domain:ordering'], digest: 'page', producer: 'agent' }]);
});

test('a missing declared page body and malformed statement or written basis refuse the read', async () => {
  await expect(graphKnowledgePages(graph({}), manifest)).rejects.toThrow('domain:payments.body');
  await expect(graphKnowledgePages(graph({ body: '', statements: [{ text: 'incomplete' }] }), manifest)).rejects.toThrow('domain:payments.statements.id');
  await expect(graphKnowledgePages(graph({ body: '', 'written-at': [{}] }), manifest)).rejects.toThrow('domain:payments.written-at');
});
