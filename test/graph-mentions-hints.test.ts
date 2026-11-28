/**
 * Decision 0039 items 5, 29 and 31: a write's hint suggestions read the same authored fields its mention scan reads
 * (madarch-47vw.9). An immutable evidence payload that states a literal answer suggests nothing, while the authored
 * field beside it keeps its hint, and the content the write stored is the payload its digest keys, byte for byte.
 *
 * The case runs in the normal shards, apart from `test/graphql-writes.test.ts`: that file is quarantined as
 * `red-defect` in `test/slow-files.json` and no shard or required matrix runs it, so the write response's hint filter
 * is covered here, on its own product fixture.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '../src/graph/digest.js';
import type { GraphContract } from '../src/graph/contract.js';
import type { OuterTransaction } from '../src/history-types.js';
import { putEntityAssertion, writeContractOf } from '../src/graph/graph-writes.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { readKindAssertions } from '../src/graph/records.js';
import { publishValidatedManifests, validateProductManifests } from '../src/graph/manifest-publication.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';

/** Two kinds are enough: an authored term whose title is a hint candidate, and an immutable payload keyed by digest. */
const MANIFEST = `kinds:
  doc.term:
    source: graph
    origin: person
    title: title
    fields:
      - { name: title, type: text, producers: [person] }
    key: []
  demo.snapshot:
    source: graph
    origin: person
    title: title
    evidence: { immutable: true, digestField: digest, contentField: content, digestAlgorithm: sha256 }
    fields:
      - { name: title, type: text, producers: [person] }
      - { name: digest, type: text, producers: [person] }
      - { name: content, type: text, producers: [person] }
      - { name: note, type: text, nullable: true, producers: [person] }
    key: [digest]
`;

/** The evidence every write of this case names: one snapshot both writes may cite. */
const CONVERSATION = 'The fixture conversation and source bytes.\nSecond source line.\nThird source line.';

let root = '';
let owner: Awaited<ReturnType<typeof createTestDatabaseOwner>>;
let contract: GraphContract;
const agent = { producer: 'agent:codex', version: 'session-1' };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-mention-hints-'));
  const folder = join(root, 'product');
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  writeFolderManifest(folder, MANIFEST);
  execFileSync('git', ['init', '-q'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['add', '-A'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  const read = validateProductManifests(folder);
  if (!read.ok || read.value === undefined) throw new Error(read.ok ? `${folder}:1: the fixture product holds no manifest` : read.findings.map(one => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
  contract = writeContractOf(read.value.manifest);
  owner = await createTestDatabaseOwner({ graphContract: contract });
  await owner.transaction('write', async tx => {
    await bindTestWriteCapability(tx, contract);
    await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from(CONVERSATION)) }, values: { content: CONVERSATION }, producer: 'fixture', producerVersion: '1' }], removals: [] });
  });
  await publishValidatedManifests(owner, read.value);
}, 120_000);

afterAll(async () => {
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

/** One write of the agent's own, in a transaction of its own: the writer's answer is the response under test. */
async function writeAs<T>(work: (tx: OuterTransaction) => Promise<T>): Promise<T> {
  return await owner.transaction('write', async tx => {
    await bindTestWriteCapability(tx, contract);
    return await work(tx);
  });
}

describe('the write response suggests only authored prose', () => {
  test('an excluded literal beside an authored mention keeps the authored hint and the exact content bytes', async () => {
    const evidence = [{ target: { kind: 'system.content-snapshot', key: { digest: sha256Hex(Buffer.from(CONVERSATION)) } }, locator: { path: 'conversation.txt' } }];
    const neighbour = await writeAs(tx => putEntityAssertion(tx, agent, { kind: 'doc.term', values: { title: 'Hint neighbour' }, evidence }));
    if (neighbour.uid === undefined) throw new Error(`${import.meta.path}:96: written fixture entity has no uid`);
    // The snapshot's content is the payload whose digest keys it, and it names the neighbour in plain words too: a hint
    // built before the exclusion would answer with that occurrence, and a scan that reads it could refuse the write.
    const content = 'A literal [[uid:<lowercase hyphenated UUID>]] example, and the Hint neighbour again.';
    const answer = await writeAs(tx => putEntityAssertion(tx, agent, {
      kind: 'demo.snapshot', key: { digest: sha256Hex(Buffer.from(content)) }, values: { title: 'A literal example', content, note: 'the Hint neighbour stated here' }, evidence,
    }));
    // The authored field keeps its hint, and the excluded content field offers none: only authored prose suggests names.
    expect(answer.hints?.filter(hint => hint.path === '/content')).toEqual([]);
    const authored = answer.hints?.filter(hint => hint.path === '/note') ?? [];
    expect(authored).toHaveLength(1);
    expect(authored[0]!.candidates.map(candidate => candidate.uid)).toEqual([neighbour.uid]);
    // The content the write stored is the payload the digest keys, byte for byte.
    const snapshot = await owner.run(tx => readKindAssertions(tx, 'vertex', 'demo.snapshot', ['content'], { contract }));
    expect(snapshot.map(record => record.values['content'])).toEqual([content]);
  }, 120_000);
});
