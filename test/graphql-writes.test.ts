/**
 * The agent's graph writes (owner's rule, 2026-11-13) on a real store: put_entity with conversation evidence read back
 * through the same GraphQL executor, an agent and a plugin disagreeing on one field, a retraction that closes only the
 * agent's opinions, and the refusals for an unknown field and an absent evidence.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { generatedTableName } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { publishValidatedManifests, validateProductManifests } from '../src/graph/manifest-publication.js';
import { putEdgeOpinion, putEntityOpinion, retractOpinion, WriteRefusal, type WriteSource } from '../src/graph/graph-writes.js';
import { executeGraphql, type MessageBody } from '../src/graph/graphql-execute.js';
import { agentSource, callProductTool, PRODUCT_TOOLS } from '../src/mcp/authored.js';
import { isRecordTool } from '../src/mcp/records.js';
import { answerUnitMcpMessage } from '../src/fill/unit-mcp.js';
import { readKinds, type KindsManifest } from '../src/product/manifest/kinds.js';
import { createTestDatabaseOwner } from './test-database.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

let root = '';
let folder = '';
let owner: DatabaseOwner;
let manifest: KindsManifest;
let contract: ReturnType<typeof graphContractOf>;
const agent: WriteSource = { producer: 'agent:codex', version: 'session-1' };

/** The operation's answer, with any error thrown rather than read as a smaller result. */
async function graphql(query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const answer = await executeGraphql(owner, { manifest, folder }, { query, ...(variables === undefined ? {} : { variables }) });
  const body = answer.body as MessageBody;
  if (body.errors !== undefined) throw new Error(`HTTP ${String(answer.status)}: ${body.errors.map((error) => error.message).join('; ')}`);
  return body.data as Record<string, unknown>;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-graphql-writes-'));
  folder = join(root, 'product');
  mkdirSync(join(folder, 'madarch/kinds/demo/core'), { recursive: true });
  mkdirSync(join(folder, 'templates'), { recursive: true });
  writeFileSync(join(folder, 'templates/entity.yaml'), 'template: entity\n');
  writeFileSync(join(folder, 'templates/term.yaml'), 'template: term\n');
  writeFileSync(join(folder, 'madarch/catalog.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-catalog.yaml'), 'utf8'));
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.repository.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.repository.yaml'), 'utf8'));
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.file.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.file.yaml'), 'utf8'));
  writeFileSync(join(folder, 'madarch/kinds/demo/core/doc.term.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-doc.term.yaml'), 'utf8'));
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.note.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.note.yaml'), 'utf8'));
  execFileSync('git', ['init', '-q'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['add', '-A'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  const read = readKinds(folder);
  if (!read.present) throw new Error('the fixture product holds no manifest');
  if (read.manifest.findings.length > 0) throw new Error(read.manifest.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
  manifest = read.manifest;
  const declared = graphContractOf(manifest);
  contract = withManifestContract({ ...declared, edge: [...declared.edge, {
    name: 'demo.contains', table: generatedTableName('demo.contains', 'edge'), from: ['demo.repository'], to: ['demo.file'],
    repeats: false, fields: [{ name: 'position', type: 'integer', nullable: true }], capability: 'fixture',
  }] });
  owner = await createTestDatabaseOwner({ graphContract: contract });
  const validation = validateProductManifests(folder);
  if (!validation.ok) throw new Error(validation.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
  if (validation.value !== undefined) await publishValidatedManifests(owner, validation.value);
}, 120_000);

afterAll(async () => {
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the agent writes the graph', () => {
  test('put_entity states a term with conversation evidence, read back over graph_query', async () => {
    const written = await putEntityOpinion(owner, agent, {
      kind: 'doc.term',
      values: { title: 'Kind', body: 'A kind is a concept the product names.' },
      evidence: [{ type: 'conversation', id: 'conversation-7', at: '2026-11-13T12:00:00Z', speaker: 'owner', words: 'A kind is a concept the product names.' }],
      words: 'the owner asked for the term Kind',
    });
    const journal = await owner.run(async (tx) => (await tx.query<{ author: string; words: string }>('SELECT author, words FROM operation ORDER BY seq DESC LIMIT 1')).rows[0]);
    expect(journal?.author).toBe('agent:codex@session-1');
    expect(journal?.words).toBe('the owner asked for the term Kind');
    expect(written.uid).toBeDefined();
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { id kind ... on DocTerm { title body titleOpinions { producer version evidence { type id at words } } } } }`, { id: written.uid });
    const term = data['entity'] as Record<string, any>;
    expect(term.kind).toBe('doc.term');
    expect(term.title).toBe('Kind');
    expect(term.body).toBe('A kind is a concept the product names.');
    expect(term.titleOpinions[0].producer).toBe('agent:codex');
    expect(term.titleOpinions[0].version).toBe('session-1');
    expect(term.titleOpinions[0].evidence[0]).toMatchObject({ type: 'conversation', id: 'conversation-7', at: '2026-11-13T12:00:00Z', words: 'A kind is a concept the product names.' });
  });

  test('an agent and a plugin that disagree give null, contested and both opinions', async () => {
    // A plugin's opinion of a repository's description, written through the same one writer.
    await owner.transaction('write', async (tx) => {
      await publishGraphDrafts(tx, contract, {
        vertices: [{ kind: 'demo.repository', key: { name: 'r1' }, values: { description: 'the plugin says this' }, producer: 'disk', producerVersion: '1' }],
        removals: [],
      }, 1, { author: 'disk@1' });
    });
    await putEntityOpinion(owner, agent, {
      kind: 'demo.repository', key: { name: 'r1' }, values: { description: 'the agent says that' },
      evidence: [{ type: 'url', url: 'https://example.test/standard', at: '2026-11-13T12:00:00Z' }],
    });
    const data = await graphql(`{ allCodeRepository: allDemoRepository(where: { name: { _eq: "r1" } }, first: 1) { edges { node { ... on DemoRepository { description contested descriptionOpinions { producer value } } } } } }`);
    const node = (data['allCodeRepository'] as Record<string, any>).edges[0].node;
    expect(node.description).toBeNull();
    expect(node.contested).toContain('description');
    expect(node.descriptionOpinions.map((one: any) => one.producer).sort()).toEqual(['agent:codex', 'disk']);
  });

  test('retract closes only the agent\'s own open opinions', async () => {
    const retracted = await retractOpinion(owner, agent, { entity: { kind: 'demo.repository', key: { name: 'r1' }, fields: ['description'] } });
    expect(retracted.retracted).toBe(true);
    const data = await graphql(`{ allDemoRepository(where: { name: { _eq: "r1" } }, first: 1) { edges { node { ... on DemoRepository { description contested descriptionOpinions { producer } } } } } }`);
    const node = (data['allDemoRepository'] as Record<string, any>).edges[0].node;
    expect(node.description).toBe('the plugin says this');
    expect(node.contested).not.toContain('description');
    expect(node.descriptionOpinions.map((one: any) => one.producer)).toEqual(['disk']);
  });

  test('put_edge states an edge, and graph_query reads its record', async () => {
    await putEntityOpinion(owner, agent, {
      kind: 'demo.file', key: { repository: { kind: 'demo.repository', key: { name: 'r1' } }, path: 'a.ts' }, values: { lines: 3 },
      evidence: [{ type: 'file', path: 'a.ts', commit: '0123456789abcdef', lineStart: 1, lineEnd: 3, repository: 'self' }],
    });
    const written = await putEdgeOpinion(owner, agent, {
      kind: 'demo.contains',
      from: { kind: 'demo.repository', key: { name: 'r1' } },
      to: { kind: 'demo.file', key: { repository: { kind: 'demo.repository', key: { name: 'r1' } }, path: 'a.ts' } },
      values: { position: 1 },
      evidence: [{ type: 'file', path: 'a.ts', blob: 'blob-1', lineStart: 1 }],
    });
    expect(written.written).toBeGreaterThan(0);
    const repository = (await graphql(`{ allDemoRepository(where: { name: { _eq: "r1" } }, first: 1) { edges { node { id } } } }`))['allDemoRepository'] as Record<string, any>;
    const id = repository.edges[0].node.id;
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { ... on DemoRepository { demoContains(first: 5) { edges { node { position opinions { producer evidence { type path } } } } } } } }`, { id });
    const edge = ((data['entity'] as Record<string, any>).demoContains.edges[0].node);
    expect(edge.position).toBe(1);
    expect(edge.opinions.map((one: any) => one.producer)).toContain('agent:codex');
    expect(edge.opinions[0].evidence[0]).toMatchObject({ type: 'file', path: 'a.ts' });
  });

  test('an unknown field is refused naming it, and evidence is required', async () => {
    const unknown = await putEntityOpinion(owner, agent, { kind: 'demo.repository', key: { name: 'r1' }, values: { nope: 1 }, evidence: [{ type: 'url', url: 'https://example.test', at: '2026-11-13T12:00:00Z' }] }).catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(WriteRefusal);
    expect((unknown as WriteRefusal).message).toContain('"nope"');
    expect((unknown as WriteRefusal).field).toBe('nope');
    const noEvidence = await putEntityOpinion(owner, agent, { kind: 'demo.repository', key: { name: 'r1' }, values: { description: 'x' }, evidence: [] }).catch((error: unknown) => error);
    expect(noEvidence).toBeInstanceOf(WriteRefusal);
    expect((noEvidence as WriteRefusal).message).toContain('evidence is required');
  });
  test('the MCP client name and the session become the producer, and initialize reports the client', async () => {
    expect(agentSource('Claude Code', 'session-9')).toEqual({ producer: 'agent:Claude-Code', version: 'session-9' });
    let heard: { name: string; version?: string } | undefined;
    await answerUnitMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-cli', version: '1.2' } } }, {
      tools: [], onClientInfo: (client) => { heard = client; }, call: async () => ({ answer: {}, isError: false }),
    });
    expect(heard).toEqual({ name: 'codex-cli', version: '1.2' });
  });

  test('the tool layer passes the agent source and refuses an unknown tool', async () => {
    let seen: WriteSource | undefined;
    const stub = {
      putEntity: async (source: WriteSource) => { seen = source; return { kind: 'doc.term', uid: 'uid-1' }; },
    } as unknown as import('../src/knowledge/product.js').KnowledgeProduct;
    const answer = await callProductTool(stub, agentSource('codex', 's1'), 'put_entity', { kind: 'doc.term', values: { title: 'Kind' }, evidence: [{ type: 'url', url: 'https://example.test', at: '2026-11-13T12:00:00Z' }] });
    expect(answer.isError).toBe(false);
    expect(seen).toEqual({ producer: 'agent:codex', version: 's1' });
    const refused = await callProductTool(stub, agentSource('codex', 's1'), 'write_anything', {});
    expect(refused.isError).toBe(true);
    expect((refused.answer as Record<string, any>).error.message).toContain('is no tool');
  });
  test('one product session serves the schema, the query and the writes', async () => {
    expect(PRODUCT_TOOLS.map((tool) => tool.name)).toEqual(['graph_schema', 'graph_query', 'put_entity', 'put_edge', 'retract']);
    // The record surface no longer carries the graph read tools: there is one session.
    expect(isRecordTool('graph_schema')).toBe(false);
    expect(isRecordTool('graph_query')).toBe(false);
    const stub = {
      graphqlSchema: async () => 'scalar BigInt\ntype Query { bootstrap: String }',
      graphql: async (operation: { query: string }) => ({ status: 200, body: { data: { echoed: operation.query } } }),
    } as unknown as import('../src/knowledge/product.js').KnowledgeProduct;
    const schema = await callProductTool(stub, agentSource('codex', 's1'), 'graph_schema', {});
    expect(schema.isError).toBe(false);
    expect((schema.answer as Record<string, unknown>)['schema']).toContain('scalar BigInt');
    const query = await callProductTool(stub, agentSource('codex', 's1'), 'graph_query', { query: '{ bootstrap }' });
    expect(query.isError).toBe(false);
    expect(query.answer).toEqual({ data: { echoed: '{ bootstrap }' } });
  });
  test('a taken kind with no fields and no plugin producer accepts put_entity and reads back its label', async () => {
    const written = await putEntityOpinion(owner, agent, {
      kind: 'demo.note',
      values: { label: 'A note the agent wrote' },
      evidence: [{ type: 'conversation', id: 'conversation-8', at: '2026-11-13T12:00:00Z', words: 'write a note' }],
    });
    expect(written.uid).toBeDefined();
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { id kind label } }`, { id: written.uid });
    const note = data['entity'] as Record<string, any>;
    expect(note.kind).toBe('demo.note');
    expect(note.label).toBe('A note the agent wrote');
  });
  test('an any-end edge stands on the Entity interface and answers both ways with a backlink', async () => {
    const term = await putEntityOpinion(owner, agent, {
      kind: 'doc.term', values: { title: 'Mentioned' },
      evidence: [{ type: 'conversation', id: 'conversation-9', at: '2026-11-13T12:00:00Z', words: 'mention the repository' }],
    });
    const edge = await putEdgeOpinion(owner, agent, {
      kind: 'mentions', from: { kind: 'doc.term', id: term.uid }, to: { kind: 'demo.repository', key: { name: 'r1' } },
      evidence: [{ type: 'file', path: 'docs/glossary.md', commit: '0123456789abcdef', lineStart: 25 }],
    });
    expect(edge.written).toBeGreaterThan(0);
    const forward = await graphql(`query ($id: ID!) { entity(id: $id) { ... on DocTerm { mentions(first: 5) { edges { node { node { ... on DemoRepository { name } } } } } } } }`, { id: term.uid });
    const mentioned = ((forward['entity'] as Record<string, any>).mentions.edges[0].node.node);
    expect(mentioned.name).toBe('r1');
    const repository = (await graphql(`{ allDemoRepository(where: { name: { _eq: "r1" } }, first: 1) { edges { node { id } } } }`))['allDemoRepository'] as Record<string, any>;
    const rid = repository.edges[0].node.id;
    const inverse = await graphql(`query ($id: ID!) { entity(id: $id) { ... on DemoRepository { mentionsOf(first: 5) { edges { node { node { ... on DocTerm { title } } } } } backlinks(first: 20) { edges { node { relation from { kind } } } } } } }`, { id: rid });
    const node = inverse['entity'] as Record<string, any>;
    expect(node.mentionsOf.edges[0].node.node.title).toBe('Mentioned');
    expect(node.backlinks.edges.some((one: any) => one.node.relation === 'mentionsOf')).toBe(true);
  });
});
