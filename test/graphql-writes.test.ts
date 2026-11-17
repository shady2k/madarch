import { sha256Hex } from '../src/graph/digest.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
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
import { publishGraphDrafts } from '../src/graph/write.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { publishValidatedManifests, validateProductManifests } from '../src/graph/manifest-publication.js';
import { putEdgeAssertion as putEdgeIn, putEntityAssertion as putEntityIn, retractAssertion as retractIn, WriteRefusal, type WriteSource } from '../src/graph/graph-writes.js';
import { executeGraphql, type MessageBody } from '../src/graph/graphql-execute.js';
import { agentSource, callProductTool, productTools } from '../src/mcp/authored.js';
import { GraphRefusal } from '../src/graph/validation.js';
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

async function writeAs<T>(source: WriteSource, work: (tx: import('../src/history-types.js').OuterTransaction) => Promise<T>): Promise<T> {
  return await owner.transaction('write', async (tx) => {
    const digest = (await import('node:crypto')).createHash('sha256').update(source.producer).digest('hex');
    await bindTestWriteCapability(tx, contract, `${digest.slice(0, 8)}-0000-7000-8000-000000000001`);
    return await work(tx);
  });
}
const putEntityAssertion = (_owner: DatabaseOwner, source: WriteSource, input: Parameters<typeof putEntityIn>[2]) => writeAs(source, (tx) => putEntityIn(tx, source, input));
const putEdgeAssertion = (_owner: DatabaseOwner, source: WriteSource, input: Parameters<typeof putEdgeIn>[2]) => writeAs(source, (tx) => putEdgeIn(tx, source, input));
const retractAssertion = (_owner: DatabaseOwner, source: WriteSource, input: Parameters<typeof retractIn>[2]) => writeAs(source, (tx) => retractIn(tx, source, input));

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
  writeFileSync(join(folder, 'madarch/catalog.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-catalog.yaml'), 'utf8').replace('language: en', `language: en
value-types:
  aliases:
    storage: json
    schema:
      $schema: https://json-schema.org/draft/2020-12/schema
      $id: https://example.test/types/aliases/v1
      type: array
      items:
        type: string`).replace('- name: mentions\n  from:\n  - demo.file', '- name: mentions\n  from:\n  - doc.term\n  - demo.file').replace('  to:\n  - demo.file\n  - demo.repository\n  repeats: true', '  to:\n  - demo.file\n  - demo.repository\n  - manifest.kind\n  repeats: true'));
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.repository.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.repository.yaml'), 'utf8'));
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.file.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.file.yaml'), 'utf8'));
  writeFileSync(join(folder, 'madarch/kinds/demo/core/doc.term.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-doc.term.yaml'), 'utf8'));
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.note.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.note.yaml'), 'utf8').replace('title: label', `title: label
naming:
  label: label
  synonyms: aliases
  domain: qualifier`).replace('key: []', `- name: aliases
  type: aliases
  schema:
    $schema: https://json-schema.org/draft/2020-12/schema
    $ref: https://example.test/types/aliases/v1
  nullable: true
  producers: [person]
- name: qualifier
  type: text
  nullable: true
  producers: [person]
- name: payload
  type: json
  nullable: true
  schema:
    $schema: https://json-schema.org/draft/2020-12/schema
    type: object
    additionalProperties:
      type: array
      items:
        type: string
  producers: [person]
key: []`));
  execFileSync('git', ['init', '-q'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['add', '-A'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  const read = readKinds(folder);
  if (!read.present) throw new Error('the fixture product holds no manifest');
  if (read.manifest.findings.length > 0) throw new Error(read.manifest.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
  manifest = read.manifest;
  // Every declared edge kind has its table (owner's rule): the manifest's own declaration is the contract.
  contract = withManifestContract(graphContractOf(manifest));
  owner = await createTestDatabaseOwner({ graphContract: contract });
  await owner.transaction('write', async (tx) => {
    await bindTestWriteCapability(tx, contract);
    await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) }, values: { content: 'The fixture conversation and source bytes.\nSecond source line.\nThird source line.' }, producer: 'fixture', producerVersion: '1' }], removals: [] });
  });
  const validation = validateProductManifests(folder);
  if (!validation.ok) throw new Error(validation.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
  if (validation.value !== undefined) await publishValidatedManifests(owner, validation.value);
}, 120_000);

afterAll(async () => {
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the agent writes the graph', () => {
  test('natural text keys validate tokens atomically and keep mention backlinks on typed key assertions', async () => {
    const evidence = [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }];
    const target = await putEntityAssertion(owner, agent, { kind: 'doc.term', values: { title: 'Key mention target' }, evidence });
    const nodeCount = () => owner.run(tx => tx.query<{ count: string }>('SELECT count(*)::text AS count FROM node'));
    for (const name of ['[[uid:bad]]', '[[uid:ffffffff-ffff-7fff-8fff-ffffffffffff]]']) {
      const before = (await nodeCount()).rows[0]!.count;
      await expect(putEntityAssertion(owner, agent, { kind: 'demo.repository', key: { name }, values: {}, evidence })).rejects.toThrow();
      expect((await nodeCount()).rows[0]!.count).toBe(before);
    }
    if (target.uid === undefined) throw new Error(`${import.meta.path}:131: target write returned no uid`);
    const targetUid = target.uid;
    const token = `[[uid:${targetUid}]]`;
    const accepted = await putEntityAssertion(owner, agent, { kind: 'demo.repository', key: { name: `😀 ${token}` }, values: {}, evidence });
    const backlinks = await owner.run(tx => tx.query<{ property: string; discriminator: string; target: string }>(`
      SELECT a.property,mention.discriminator,target.uid::text AS target
      FROM node n JOIN edge subject ON subject.to_node=n.id
      JOIN entity sk ON sk.id=subject.entity_id AND sk.name='system.assertion-subject'
      JOIN assertion a ON a.assertion_id=subject.from_node
      JOIN edge mention ON mention.from_node=a.assertion_id
      JOIN entity mk ON mk.id=mention.entity_id AND mk.name='system.assertion-mentions'
      JOIN node target ON target.id=mention.to_node WHERE n.uid=$1::uuid`, [accepted.uid]));
    expect(backlinks.rows.map(row => ({ property: row.property, occurrence: JSON.parse(row.discriminator), target: row.target }))).toEqual([
      { property: 'name', occurrence: { path: '/values/name', start: 2, end: 2 + token.length }, target: targetUid },
    ]);
  });

  test('naming declarations reject unknown fields and untyped synonym containers', () => {
    const path = join(folder, 'madarch/kinds/demo/core/demo.note.yaml');
    const content = readFileSync(path, 'utf8');
    try {
      for (const [before, after, expected] of [
        ['  synonyms: aliases', '  synonyms: payload', 'synonyms requires a named registry JSON value type'],
        ['  domain: qualifier', '  domain: absent', 'a naming slot names a declared field'],
        ['  label: label', '  label: aliases', 'label requires a text field'],
        ['  label: label\n', '', 'naming requires an explicit label field'],
      ] as const) {
        writeFileSync(path, content.replace(before, after));
        const result = readKinds(folder);
        if (!result.present) throw new Error(`${path}:1: missing manifest`);
        const finding = result.manifest.findings.find(finding => finding.message.includes(expected));
        expect(finding).toBeDefined();
        expect(finding?.file).toBe(path);
        expect(finding?.line).toBeGreaterThan(0);
      }
    } finally { writeFileSync(path, content); }
  });

  test('write answers preserve every ambiguous declared title, including decoded JSON spans', async () => {
    const evidence = [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }];
    const first = await putEntityAssertion(owner, agent, { kind: 'doc.term', values: { title: 'Shared label' }, evidence });
    const second = await putEntityAssertion(owner, agent, { kind: 'demo.note', values: { label: 'A qualified concept', aliases: ['Shared label', 'Shared label'], qualifier: 'Commerce' }, evidence });
    const third = await putEntityAssertion(owner, agent, { kind: 'doc.term', values: { title: 'Shared label' }, evidence });
    const keyed = await putEntityAssertion(owner, agent, { kind: 'demo.repository', key: { name: 'Shared label' }, values: {}, evidence });
    const answer = await putEntityAssertion(owner, agent, {
      kind: 'demo.note', values: { label: 'A separate note', payload: { 'a~/': ['😀 Shared label Shared label'] } }, evidence,
    });
    const candidates = [first, second, third, keyed].map(item => {
      if (item.uid === undefined) throw new Error(`${import.meta.path}:150: written fixture entity has no uid`);
      return { uid: item.uid, kind: item.kind, label: item === second ? 'A qualified concept' : 'Shared label', domain: item === second ? 'Commerce' : '' };
    }).sort((left, right) => left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : left.uid < right.uid ? -1 : 1);
    expect(answer.hints?.filter(hint => hint.path === '/payload/a~0~1/0')).toEqual([
      { path: '/payload/a~0~1/0', start: 2, end: 14, candidates },
      { path: '/payload/a~0~1/0', start: 15, end: 27, candidates },
    ]);
    expect(new Set(candidates.map(candidate => candidate.uid)).size).toBe(4);
  });

  test('put_entity states a term with conversation evidence, read back over graph_query', async () => {
    const written = await putEntityAssertion(owner, agent, {
      kind: 'doc.term',
      values: { title: 'Kind', body: 'A kind is a concept the product names.' },
      evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }],
      words: 'the owner asked for the term Kind',
    });
    expect(written.uid).toBeDefined();
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { id kind ... on KindDocTerm { title body titleAssertions { source { id } evidence { target { kind } locator } } } } }`, { id: written.uid });
    const term = data['entity'] as Record<string, any>;
    expect(term.kind).toBe('doc.term');
    expect(term.title).toBe('Kind');
    expect(term.body).toBe('A kind is a concept the product names.');
    expect(term.titleAssertions[0].evidence[0]).toMatchObject({ target: { kind: 'system.content-snapshot' }, locator: { path: 'conversation.txt' } });
  });

  test('an agent and a plugin that disagree give null, contested and both opinions', async () => {
    // A plugin's opinion of a repository's description, written through the same one writer.
    await owner.transaction('write', async (tx) => {
      await bindTestWriteCapability(tx, contract);
      await publishGraphDrafts(tx, contract, {
        vertices: [{ kind: 'demo.repository', key: { name: 'r1' }, values: { description: 'the plugin says this' }, producer: 'disk', producerVersion: '1' }],
        removals: [],
      }, 1, { author: 'disk@1' });
    });
    await putEntityAssertion(owner, agent, {
      kind: 'demo.repository', key: { name: 'r1' }, values: { description: 'the agent says that' },
      evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }],
    });
    const data = await graphql(`{ allCodeRepository: allDemoRepository(where: { name: { _eq: "r1" } }, first: 1) { edges { node { ... on KindDemoRepository { description contested descriptionAssertions { source { id } value } } } } } }`);
    const node = (data['allCodeRepository'] as Record<string, any>).edges[0].node;
    expect(node.description).toBe('the agent says that');
    expect(node.contested).toContain('description');
    expect(node.descriptionAssertions.map((one: any) => one.source.id).sort()).toEqual(['019a0000-0000-7000-8000-000000000002', 'c452d2e1-0000-7000-8000-000000000001']);
  });

  test('retract closes only the agent\'s own open opinions', async () => {
    const retracted = await retractAssertion(owner, agent, { entity: { kind: 'demo.repository', key: { name: 'r1' }, fields: ['description'] }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }] });
    expect(retracted.retracted).toBe(true);
    const data = await graphql(`{ allDemoRepository(where: { name: { _eq: "r1" } }, first: 1) { edges { node { ... on KindDemoRepository { description contested descriptionAssertions { source { id } operation } } } } } }`);
    const node = (data['allDemoRepository'] as Record<string, any>).edges[0].node;
    expect(node.description).toBe('the plugin says this');
    expect(node.contested).not.toContain('description');
    expect(node.descriptionAssertions.map((one: any) => one.operation)).toContain('RETRACT');
  });

  test('put_edge states an edge, and graph_query reads its record', async () => {
    await putEntityAssertion(owner, agent, {
      kind: 'demo.file', key: { path: 'a.ts' }, keyEdges: { repository: { kind: 'demo.repository', key: { name: 'r1' } } }, values: { lines: 3 },
      evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'a.ts', commit: '0123456789abcdef', lineStart: 1, lineEnd: 3 } }],
    });
    const written = await putEdgeAssertion(owner, agent, {
      kind: 'demo.contains',
      from: { kind: 'demo.repository', key: { name: 'r1' } },
      to: { kind: 'demo.file', key: { path: 'a.ts' }, keyEdges: { repository: { kind: 'demo.repository', key: { name: 'r1' } } } },
      values: { position: 1 },
      evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'a.ts', lineStart: 1  } }],
    });
    expect(written.written).toBeGreaterThan(0);
    const repository = (await graphql(`{ allDemoRepository(where: { name: { _eq: "r1" } }, first: 1) { edges { node { id } } } }`))['allDemoRepository'] as Record<string, any>;
    const id = repository.edges[0].node.id;
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { ... on KindDemoRepository { demoContains(first: 5) { edges { node { position assertions { source { id } evidence { target { kind } locator } } } } } } } }`, { id });
    const edge = ((data['entity'] as Record<string, any>).demoContains.edges[0].node);
    expect(edge.position).toBe(1);
    expect(edge.assertions.map((one: any) => one.source.id)).toContain('c452d2e1-0000-7000-8000-000000000001');
    expect(edge.assertions[0].evidence[0]).toMatchObject({ target: { kind: 'system.content-snapshot' }, locator: { path: 'a.ts', lineStart: 1 } });
  });

  test('an unknown field is refused naming it, and evidence is required', async () => {
    const unknown = await putEntityAssertion(owner, agent, { kind: 'demo.repository', key: { name: 'r1' }, values: { nope: 1 }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }] }).catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(GraphRefusal);
    expect((unknown as GraphRefusal).path).toBe('/values/nope');
    expect((unknown as GraphRefusal).actual).toBe(1);
    const noEvidence = await putEntityAssertion(owner, agent, { kind: 'demo.repository', key: { name: 'r1' }, values: { description: 'x' }, evidence: [] }).catch((error: unknown) => error);
    expect(noEvidence).toBeInstanceOf(GraphRefusal);
    expect((noEvidence as GraphRefusal).path).toBe('/evidence');
  });
  test('the MCP client name and the session become the producer, and initialize reports the client', async () => {
    expect(agentSource('Claude Code', 'session-9')).toEqual({ producer: 'agent:Claude-Code', version: 'session-9' });
    let heard: { name: string; version?: string } | undefined;
    await answerUnitMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-cli', version: '1.2' } } }, {
      tools: [], onClientInfo: (client) => { heard = client; }, call: async () => ({ answer: {}, isError: false }),
    });
    expect(heard).toEqual({ name: 'codex-cli', version: '1.2' });
  });

  test('the tool layer passes the host grant separately from display source and refuses an unknown tool', async () => {
    const { agentBinding } = await import('../src/graph/system-installation.js');
    const { withAssertionContract } = await import('../src/graph/system-contract.js');
    const { writeContractOf } = await import('../src/graph/graph-writes.js');
    const grant = await agentBinding(owner, withAssertionContract(writeContractOf(manifest)), 'tool-forwarding');
    let seen: WriteSource | undefined;
    let seenBinding: unknown;
    const stub = {
      requestContract: async () => contract,
      putEntity: async (source: WriteSource, _input: unknown, options: { hostBinding: unknown }) => { seen = source; seenBinding = options.hostBinding; return { kind: 'doc.term', uid: 'uid-1' }; },
    } as unknown as import('../src/knowledge/product.js').KnowledgeProduct;
    const answer = await callProductTool(stub, agentSource('codex', 's1'), 'put_entity', { kind: 'doc.term', values: { title: 'Kind' }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }] }, grant);
    expect(answer.isError).toBe(false);
    expect(seen).toEqual({ producer: 'agent:codex', version: 's1' });
    expect(seenBinding).toBe(grant);
    const refused = await callProductTool(stub, agentSource('codex', 's1'), 'write_anything', {});
    expect(refused.isError).toBe(true);
    expect((refused.answer as Record<string, any>).error).toMatchObject({ code: 'SCHEMA_INVALID', path: '/tool', actual: 'write_anything' });
  });
  test('one product session serves the schema, the query and the writes', async () => {
    expect(productTools(contract).map((tool) => tool.name)).toEqual(['graph_schema', 'graph_query', 'render_diagram', 'put_entity', 'put_edge', 'retract', 'graph_resolve_dispute']);
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
    const written = await putEntityAssertion(owner, agent, {
      kind: 'demo.note',
      values: { label: 'A note the agent wrote' },
      evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }],
    });
    expect(written.uid).toBeDefined();
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { id kind label } }`, { id: written.uid });
    const note = data['entity'] as Record<string, any>;
    expect(note.kind).toBe('demo.note');
    expect(note.label).toBe('A note the agent wrote');
  });
  test('an any-end edge stands on the Entity interface and answers both ways with a backlink', async () => {
    const term = await putEntityAssertion(owner, agent, {
      kind: 'doc.term', values: { title: 'Mentioned' },
      evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }],
    });
    const edge = await putEdgeAssertion(owner, agent, {
      kind: 'mentions', from: { kind: 'doc.term', id: term.uid }, to: { kind: 'demo.repository', key: { name: 'r1' } },
      discriminator: 'docs/glossary.md:25:1',
      evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'docs/glossary.md', commit: '0123456789abcdef', lineStart: 25  } }],
    });
    expect(edge.written).toBeGreaterThan(0);
    const forward = await graphql(`query ($id: ID!) { entity(id: $id) { ... on KindDocTerm { mentions(first: 5) { edges { node { node { ... on KindDemoRepository { name } } } } } } } }`, { id: term.uid });
    const mentioned = ((forward['entity'] as Record<string, any>).mentions.edges[0].node.node);
    expect(mentioned.name).toBe('r1');
    const repository = (await graphql(`{ allDemoRepository(where: { name: { _eq: "r1" } }, first: 1) { edges { node { id } } } }`))['allDemoRepository'] as Record<string, any>;
    const rid = repository.edges[0].node.id;
    const inverse = await graphql(`query ($id: ID!) { entity(id: $id) { ... on KindDemoRepository { mentionsOf(first: 5) { edges { node { node { ... on KindDocTerm { title } } } } } backlinks(first: 20) { edges { node { relation from { kind } } } } } } }`, { id: rid });
    const node = inverse['entity'] as Record<string, any>;
    expect(node.mentionsOf.edges[0].node.node.title).toBe('Mentioned');
    expect(node.backlinks.edges.some((one: any) => one.node.relation === 'mentionsOf')).toBe(true);
  });
  test('an edge end must be a kind the edge declares, and a non-nullable attribute takes no null', async () => {
    const repositoryKey = { name: 'r1' };
    const fileKey = { path: 'a.ts' };
    const fileParents = { repository: { kind: 'demo.repository', key: repositoryKey } };
    const reversed = await putEdgeAssertion(owner, agent, {
      kind: 'demo.contains', from: { kind: 'demo.file', key: fileKey, keyEdges: fileParents }, to: { kind: 'demo.repository', key: repositoryKey },
      evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }],
    }).catch((error: unknown) => error);
    expect(reversed).toBeInstanceOf(GraphRefusal);
    expect((reversed as GraphRefusal).path).toBe('/from');
    const nullAttribute = await putEdgeAssertion(owner, agent, {
      kind: 'demo.sized', from: { kind: 'demo.repository', key: repositoryKey }, to: { kind: 'demo.file', key: fileKey, keyEdges: fileParents },
      values: { weight: null }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }],
    }).catch((error: unknown) => error);
    expect(nullAttribute).toBeInstanceOf(GraphRefusal);
    expect((nullAttribute as GraphRefusal).path).toBe('/values/weight');
    const sized = await putEdgeAssertion(owner, agent, {
      kind: 'demo.sized', from: { kind: 'demo.repository', key: repositoryKey }, to: { kind: 'demo.file', key: fileKey, keyEdges: fileParents },
      values: { weight: 3 }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }],
    });
    expect(sized.written).toBeGreaterThan(0);
  });

  test('the answer uid is always the entity written, and a keyless entity is written again by id', async () => {
    const first = await putEntityAssertion(owner, agent, { kind: 'demo.note', values: { label: 'first' }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }] });
    const second = await putEntityAssertion(owner, agent, { kind: 'demo.note', values: { label: 'second' }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }] });
    expect(first.uid).toBeDefined();
    expect(second.uid).toBeDefined();
    expect(first.uid).not.toBe(second.uid);
    const again = await putEntityAssertion(owner, agent, { kind: 'demo.note', id: first.uid, values: { label: 'first' }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }] });
    expect(again.uid).toBe(first.uid);
    const corrected = await putEntityAssertion(owner, agent, { kind: 'demo.note', id: first.uid, values: { label: 'first, corrected' }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }] });
    expect(corrected.uid).toBe(first.uid);
    const read = await graphql(`query ($id: ID!) { entity(id: $id) { label } }`, { id: first.uid });
    expect((read['entity'] as Record<string, any>).label).toBe('first, corrected');
    // The same for a keyed kind: two entities, one restated, answer their own uid.
    const a = await putEntityAssertion(owner, agent, { kind: 'demo.repository', key: { name: 'u1' }, values: { description: 'a' }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }] });
    const b = await putEntityAssertion(owner, agent, { kind: 'demo.repository', key: { name: 'u2' }, values: { description: 'b' }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }] });
    const restated = await putEntityAssertion(owner, agent, { kind: 'demo.repository', key: { name: 'u1' }, values: { description: 'a' }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }] });
    expect(restated.uid).toBe(a.uid);
    expect(a.uid).not.toBe(b.uid);
  });

  test('a uid that belongs to another kind is refused, naming the uid, its kind and the kind asked', async () => {
    const evidence = [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }];
    await putEntityAssertion(owner, agent, { kind: 'demo.repository', key: { name: 'cross' }, values: { description: 'a repository' }, evidence });
    const file = await putEntityAssertion(owner, agent, {
      kind: 'demo.file', key: { path: 'src/a.ts' }, keyEdges: { repository: { kind: 'demo.repository', key: { name: 'cross' } } }, values: { lines: 3 }, evidence,
    });
    // A keyless kind's uid may be a file's: the write must not attach its opinion to that file's node.
    const refused = await putEntityAssertion(owner, agent, { kind: 'demo.note', id: file.uid, values: { label: 'a note on a file' }, evidence }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WriteRefusal);
    expect((refused as WriteRefusal).status).toBe(409);
    expect((refused as WriteRefusal).message).toContain(String(file.uid));
    expect((refused as WriteRefusal).message).toContain('"demo.file"');
    expect((refused as WriteRefusal).message).toContain('"demo.note"');
    const notes = await owner.run((tx) => tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM assertion a JOIN assertion_vertex_subject av ON av.assertion_id=a.assertion_id JOIN edge e ON e.id=av.subject_edge_id JOIN node n ON n.id=e.to_node JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid AND k.name='demo.note'`, [file.uid]));
    expect(notes.rows[0]!.n).toBe('0');
    // And the other way: a note's uid asked as a file names the kind the uid belongs to, not "no entity of the kind".
    const note = await putEntityAssertion(owner, agent, { kind: 'demo.note', values: { label: 'a note' }, evidence });
    const reverse = await putEntityAssertion(owner, agent, { kind: 'demo.file', id: note.uid, values: { lines: 1 }, evidence }).catch((error: unknown) => error);
    expect(reverse).toBeInstanceOf(WriteRefusal);
    expect((reverse as WriteRefusal).status).toBe(409);
    expect((reverse as WriteRefusal).message).toContain('"demo.note"');
    expect((reverse as WriteRefusal).message).toContain('"demo.file"');
  });

  test('a retraction names its evidence, and the journal keeps why', async () => {
    const missing = await retractAssertion(owner, agent as WriteSource, { entity: { kind: 'demo.repository', key: { name: 'u1' }, fields: ['description'] }, evidence: [] }).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(WriteRefusal);
    expect((missing as WriteRefusal).message).toContain('graph target is required');
    const done = await retractAssertion(owner, agent, { entity: { kind: 'demo.repository', key: { name: 'u1' }, fields: ['description'] }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }] });
    expect(done.retracted).toBe(true);
    const history = await owner.run((tx) => tx.query<{ operation: string }>(`SELECT a.operation FROM assertion a JOIN assertion_vertex_subject av ON av.assertion_id=a.assertion_id JOIN edge se ON se.id=av.subject_edge_id JOIN node n ON n.id=se.to_node WHERE n.key->>'name'='u1' AND a.property='description' ORDER BY a.recorded_sequence DESC LIMIT 1`));
    expect(history.rows[0]?.operation).toBe('retract');
  });

  test('an edge retraction keeps another producer\'s opinion and the edge', async () => {
    await owner.transaction('write', async (tx) => {
      await bindTestWriteCapability(tx, contract);
      await publishGraphDrafts(tx, contract, {
        vertices: [],
        edges: [{ kind: 'demo.contains', from: { kind: 'demo.repository', key: { name: 'r1' } }, to: { kind: 'demo.file', key: { path: 'a.ts' }, keyEdges: { repository: { kind: 'demo.repository', key: { name: 'r1' } } } }, values: { position: 7 }, producer: 'disk', producerVersion: '1' }],
        removals: [],
      }, 1, { author: 'disk@1' });
    });
    const fileKey = { kind: 'demo.file', key: { path: 'a.ts' }, keyEdges: { repository: { kind: 'demo.repository', key: { name: 'r1' } } } };
    await putEdgeAssertion(owner, agent, {
      kind: 'demo.contains', from: { kind: 'demo.repository', key: { name: 'r1' } }, to: fileKey, values: { position: 8 },
      evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }],
    });
    const retracted = await retractAssertion(owner, agent, {
      edge: { kind: 'demo.contains', from: { kind: 'demo.repository', key: { name: 'r1' } }, to: fileKey },
      evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }],
    });
    expect(retracted.retracted).toBe(true);
    const repository = (await graphql(`{ allDemoRepository(where: { name: { _eq: "r1" } }, first: 1) { edges { node { id } } } }`))['allDemoRepository'] as Record<string, any>;
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { ... on KindDemoRepository { demoContains(where: { position: { _gt: 0 } }, first: 10) { edges { node { position assertions { source { id } operation } } } } } } }`, { id: repository.edges[0].node.id });
    const edges = ((data['entity'] as Record<string, any>).demoContains.edges).map((one: any) => one.node);
    const kept = edges.find((one: any) => one.position === 7);
    expect(kept).toBeDefined();
    expect(kept.assertions.some((one: any) => one.source.id === '019a0000-0000-7000-8000-000000000002' && one.operation === 'ASSERT')).toBe(true);
  });

  test('an entity retraction respects a restricted key-edge dependent', async () => {
    const repoKey = { name: 'keep-edge' };
    const fileKey = { path: 'x.ts' };
    const fileParents = { repository: { kind: 'demo.repository', key: repoKey } };
    await putEntityAssertion(owner, agent, { kind: 'demo.repository', key: repoKey, values: { description: 'agent only' }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }] });
    await putEntityAssertion(owner, agent, { kind: 'demo.file', key: fileKey, keyEdges: fileParents, values: { lines: 1 }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }] });
    await owner.transaction('write', async (tx) => {
      await bindTestWriteCapability(tx, contract);
      await publishGraphDrafts(tx, contract, {
        vertices: [],
        edges: [{ kind: 'demo.contains', from: { kind: 'demo.repository', key: repoKey }, to: { kind: 'demo.file', key: fileKey, keyEdges: fileParents }, values: { position: 1 }, producer: 'disk', producerVersion: '1' }],
        removals: [],
      }, 1, { author: 'disk@1' });
    });
    await expect(retractAssertion(owner, agent, { entity: { kind: 'demo.repository', key: repoKey }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } } }] })).rejects.toThrow('PARENT_DELETE_RESTRICTED');
    const kept = (await graphql(`{ allDemoRepository(where: { name: { _eq: "keep-edge" } }, first: 1) { totalCount } }`))['allDemoRepository'] as Record<string, any>;
    expect(kept.totalCount).toBe(1);
  });

  test('a catalogue identity a read returns is accepted as an edge end', async () => {
    const catalogue = (await graphql(`{ catalogueEntity(name: "demo.repository") { id } }`))['catalogueEntity'] as Record<string, any>;
    expect(catalogue.id).toBeDefined();
    const term = await putEntityAssertion(owner, agent, { kind: 'doc.term', values: { title: 'Catalogue mention' }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }] });
    const edge = await putEdgeAssertion(owner, agent, {
      kind: 'mentions', from: { kind: 'doc.term', id: term.uid }, to: { kind: 'manifest.kind', id: catalogue.id },
      discriminator: 'docs/glossary.md:25:1',
      evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'docs/glossary.md', commit: '0123456789abcdef', lineStart: 25  } }],
    });
    expect(edge.written).toBeGreaterThan(0);
    const read = await graphql(`query ($id: ID!) { entity(id: $id) { ... on ManifestKind { mentionsOf(first: 5) { totalCount } } } }`, { id: catalogue.id });
    expect((read['entity'] as Record<string, any>).mentionsOf.totalCount).toBeGreaterThanOrEqual(1);
  });

  test('an unknown tool argument and non-text words are refused at the tool boundary', async () => {
    const stub = { requestContract: async () => contract, putEntity: async () => ({ kind: 'doc.term' }) } as unknown as import('../src/knowledge/product.js').KnowledgeProduct;
    const unknown = await callProductTool(stub, agentSource('codex', 's1'), 'put_entity', { kind: 'doc.term', values: {}, evidence: [], valuess: 1 });
    expect(unknown.isError).toBe(true);
    expect((unknown.answer as Record<string, any>).error.path).toBe('/valuess');
    const words = await callProductTool(stub, agentSource('codex', 's1'), 'put_entity', { kind: 'doc.term', values: { title: 'x' }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } } }], words: ['x'] });
    expect(words.isError).toBe(true);
    expect((words.answer as Record<string, any>).error.path).toBe('/words');
    const preconditions = await callProductTool(stub, agentSource('codex', 's1'), 'put_entity', {
      kind: 'doc.term', values: { title: 'Valid title' }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } } }],
      preconditions: [{ uid: '019a0000-0000-7000-8000-000000000001', recordedSequence: '1', extra: true }],
    });
    expect(preconditions.isError).toBe(true);
    expect((preconditions.answer as Record<string, any>).error.path).toBe('/preconditions/0/extra');
  });
  test('two mentions of one entity stay apart by their places, and a retraction closes one', async () => {
    const term = await putEntityAssertion(owner, agent, { kind: 'doc.term', values: { title: 'Occurrences' }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }] });
    const repository = { kind: 'demo.repository', key: { name: 'r1' } };
    const evidence = [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'docs/glossary.md', commit: '0123456789abcdef', lineStart: 3  } }];
    await putEdgeAssertion(owner, agent, { kind: 'mentions', from: { kind: 'doc.term', id: term.uid }, to: repository, discriminator: 'docs/glossary.md:3:1', evidence });
    await putEdgeAssertion(owner, agent, { kind: 'mentions', from: { kind: 'doc.term', id: term.uid }, to: repository, discriminator: 'docs/glossary.md:9:1', evidence });
    const both = await graphql(`query ($id: ID!) { entity(id: $id) { ... on KindDocTerm { mentions(first: 10) { totalCount edges { node { discriminator } } } } } }`, { id: term.uid });
    const mentions = (both['entity'] as Record<string, any>).mentions;
    expect(mentions.totalCount).toBe(2);
    expect(mentions.edges.map((one: any) => one.node.discriminator).sort()).toEqual(['docs/glossary.md:3:1', 'docs/glossary.md:9:1']);
    const retracted = await retractAssertion(owner, agent, {
      edge: { kind: 'mentions', from: { kind: 'doc.term', id: term.uid }, to: repository, discriminator: 'docs/glossary.md:3:1' },
      evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }],
    });
    expect(retracted.retracted).toBe(true);
    const left = await graphql(`query ($id: ID!) { entity(id: $id) { ... on KindDocTerm { mentions(first: 10) { totalCount edges { node { discriminator } } } } } }`, { id: term.uid });
    const after = (left['entity'] as Record<string, any>).mentions;
    expect(after.totalCount).toBe(1);
    expect(after.edges[0].node.discriminator).toBe('docs/glossary.md:9:1');
  });
  test('a mention to a catalogue entity is retracted by the identity the read returned', async () => {
    const catalogue = (await graphql(`{ catalogueEntity(name: "demo.file") { id } }`))['catalogueEntity'] as Record<string, any>;
    const term = await putEntityAssertion(owner, agent, { kind: 'doc.term', values: { title: 'Catalogue retract' }, evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }] });
    await putEdgeAssertion(owner, agent, {
      kind: 'mentions', from: { kind: 'doc.term', id: term.uid }, to: { kind: 'manifest.kind', id: catalogue.id }, discriminator: 'docs/r.md:1:1',
      evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }],
    });
    const retracted = await retractAssertion(owner, agent, {
      edge: { kind: 'mentions', from: { kind: 'doc.term', id: term.uid }, to: { kind: 'manifest.kind', id: catalogue.id }, discriminator: 'docs/r.md:1:1' },
      evidence: [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from('The fixture conversation and source bytes.\nSecond source line.\nThird source line.')) } }, locator: { path: 'conversation.txt' } }],
    });
    expect(retracted.retracted).toBe(true);
  });
});
