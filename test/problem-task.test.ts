/** Problem tasks use the closed manual operation and graph lineage (0039.1,14,24–26). */
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { createTestDatabaseOwner } from './test-database.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { validateProductManifests, publishValidatedManifests, startupBinding } from '../src/graph/manifest-publication.js';
import { writeContractOf } from '../src/graph/graph-writes.js';
import { executeManualOperation } from '../src/graph/manual-operation.js';
import { bindWriteCapability, publishGraphDrafts, resolveEntityRef } from '../src/graph/write.js';
import { readKindAssertions } from '../src/graph/records.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import { createDraft } from '../src/product/draft.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { retainTestStorePreparationOwner } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { personOperationBinding } from '../src/graph/system-installation.js';
import { registerGraphPrincipal, bindGraphProducer, producerIdentityOf, type ProducerBinding } from '../src/graph/producer-binding.js';
import { newUid } from '../src/graph/uid.js';
import { problemTaskRecord, problemTaskSource, problemFingerprint } from '../src/loop/problem-task.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-problem-task-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
async function fixture(bound = true, existing?: { folder: string; store: string }) {
  const folder = existing?.folder ?? mkdtempSync(join(root, 'product-'));
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  writeFolderManifest(folder, stringify({
    ...(bound ? { 'semantic-bindings': { document: { kind: 'document', fields: { path: 'path', content: 'content', anchors: 'anchors' }, edges: { repository: { kind: 'document-repository', direction: 'from' } } }, repository: { kind: 'repository', fields: { name: 'name', url: 'url', default_branch: 'default_branch', history_shallow: 'history_shallow', tree_snapshot: 'tree_snapshot' } }, file: { kind: 'code.file', fields: Object.fromEntries(['path', 'mode', 'blob', 'bytes', 'form', 'lines', 'language', 'languages', 'content'].map(name => [name, name])) }, 'problem-task': { kind: 'task', fields: { title: 'title', description: 'description', tracker: 'tracker', key: 'key', status: 'status' }, values: { tracker: { local: 'local' }, status: { open: 'open' } }, edges: { problems: { kind: 'task-problem', direction: 'from' } } } } } : {}),
    problems: { thresholds: { largeFileLines: 600, hotspotLines: 200, hotspotCommits: 10, hotspotScore: 10000 }, rules: { 'large-file': { predicate: 'large-file', kind: 'large-file', sonar: 'code-smell', severity: 'minor', section: 'code', action: 'task', label: { en: 'Large file', ru: 'Большой файл' } } } },
    edges: [{ name: 'document-repository', role: 'containment', direction: 'out', from: ['document'], to: ['repository'], cardinality: { from: { min: 0, max: 1 }, to: { min: 0, max: null } }, labels: { en: { out: 'belongs to', in: 'contains document' }, ru: { out: 'belongs to', in: 'contains document' } } }, { name: 'task-problem', role: 'reference', direction: 'out', from: ['task'], to: ['system.problem'], cardinality: { from: { min: 0, max: 1 }, to: { min: 0, max: null } }, labels: { en: { out: 'addresses', in: 'addressed by' }, ru: { out: 'исправляет', in: 'исправляется' } } }],
    kinds: {
      document: { source: 'graph', key: ['path'], fields: [
        { name: 'path', type: 'text', producers: ['fixture'] },
        { name: 'content', type: 'text', producers: ['fixture'] },
        { name: 'anchors', type: 'json', schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: { type: 'object', properties: { title: { type: 'string' }, start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 }, markdown: { type: 'string' } }, required: ['title', 'start', 'end', 'markdown'], additionalProperties: false } }, producers: ['fixture'] },
      ] },
      task: { source: 'graph', key: ['tracker', 'key'], fields: ['tracker', 'key', 'title', 'description', 'status'].map(name => ({ name, type: 'text', producers: ['person'] })) },
      repository: { source: 'graph', key: ['name'], fields: ['name', 'url', 'default_branch', 'tree_snapshot', 'history_shallow'].map(name => ({ name, type: name === 'history_shallow' ? 'boolean' : 'text', nullable: name !== 'name', producers: ['fixture'] })) },
      'code.file': { source: 'graph', key: ['repository', 'path'], fields: ['repository', 'path', 'mode', 'blob', 'bytes', 'form', 'lines', 'language', 'languages', 'content'].map(name => ({ name, type: ['bytes', 'lines'].includes(name) ? 'bigint' : name === 'languages' ? 'json' : 'text', ...(name === 'languages' ? { schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'array', items: { type: 'string' } } } : {}), nullable: !['repository', 'path'].includes(name), producers: ['fixture'] })) },
      subject: { source: 'graph', key: ['name'], fields: [{ name: 'name', type: 'text', producers: ['fixture'] }] },
    },
  }));
  execFileSync('git', ['init', '-q', folder]);
  execFileSync('git', ['-C', folder, 'add', '-A']);
  execFileSync('git', ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'fixture']);
  const validated = validateProductManifests(folder);
  if (!validated.ok || !validated.value) throw new Error(`${folder}:1: ${JSON.stringify(validated)}`);
  const contract = writeContractOf(validated.value.manifest);
  const owner = await createTestDatabaseOwner({ graphContract: contract, ...(existing ? { store: existing.store } : {}) });
  await publishValidatedManifests(owner, validated.value);
  const about = await owner.transaction('write', async tx => {
    const authenticated = await startupBinding(tx, contract, 'fixture');
    bindWriteCapability(tx, authenticated.binding);
    const reference = { kind: 'subject', key: { name: 'src/big.ts' } };
    await publishGraphDrafts(tx, contract, { vertices: [{ ...reference, values: {}, producer: 'fixture', producerVersion: '1' }], removals: [] });
    return { ...reference, uid: (await resolveEntityRef(tx, contract, reference)).uid };
  });
  const grant = await personOperationBinding(owner, withAssertionContract(contract), 'problem-task');
  return { owner, about, folder, contract, grant };
}
const person = (name: string, email: string, operationId: string) => ({ ...problemTaskSource({ name, email }), operationId });
const request = (finding: string, about?: { kind: string; key: Record<string, string>; uid: string }) => ({ kind: 'problem-task' as const, input: { rule: 'large-file', fingerprint: problemFingerprint({ rule: 'large-file', reason: `731 lines exceed the 600-line limit: ${finding}`, file: 'src/big.ts', line: 1 }, about?.uid ?? null), reason: `731 lines exceed the 600-line limit: ${finding}`, title: 'Fix: Large file — src/big.ts:1', description: 'Split the module into smaller units.', ...(about ? { about } : {}) } });

test('manual problem task is idempotent and stores problem/about/task as graph identities, not front JSON', async () => {
  const { owner, about, grant, contract } = await fixture();
  try {
    const actor = person('Alice@work', 'alice@example.test', 'first-press');
    const operation = request('same-fingerprint', about);
    const first = await executeManualOperation(owner, actor, operation, grant);
    expect(await executeManualOperation(owner, actor, operation, grant)).toEqual(first);
    const second = await executeManualOperation(owner, { ...actor, operationId: 'second-press' }, operation, grant);
    expect(second.uid).toBe(first.uid);
    const tasks = await owner.run(tx => readKindAssertions(tx, 'vertex', 'task', ['title', 'description', 'status'], { contract: withAssertionContract(contract) }));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.key).toEqual({ tracker: 'local', key: operation.input.fingerprint });
    expect(tasks[0]!.values).toMatchObject({ title: operation.input.title, description: operation.input.description, status: 'open' });
    expect(tasks[0]!.values).not.toHaveProperty('front');
    const problems = await owner.run(tx => readKindAssertions(tx, 'vertex', 'system.problem', ['rule', 'fingerprint', 'reason'], { contract: withAssertionContract(contract) }));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.values).toMatchObject({ rule: 'large-file', fingerprint: operation.input.fingerprint, reason: operation.input.reason });
    const links = await owner.run(tx => readKindAssertions(tx, 'edge', 'task-problem', [], { contract: withAssertionContract(contract) }));
    expect(links.map(edge => [edge.from, edge.to])).toEqual([[tasks[0]!.id, problems[0]!.id]]);
    const aboutLinks = await owner.run(tx => readKindAssertions(tx, 'edge', 'system.problem-about', [], { contract: withAssertionContract(contract) }));
    expect(aboutLinks).toHaveLength(1);
    expect(aboutLinks[0]!.from).toBe(problems[0]!.id);
    const subjects = await owner.run(tx => readKindAssertions(tx, 'vertex', 'subject', [], { contract: withAssertionContract(contract) }));
    expect(subjects.find(row => row.id === aboutLinks[0]!.to)?.uid).toBe(about.uid);
    const title = await owner.run(tx => loadAssertions(tx, 'vertex', 'task', ['title']));
    const snapshots = await owner.run(tx => readKindAssertions(tx, 'vertex', 'system.content-snapshot', ['content'], { contract: withAssertionContract(contract) }));
    const diagnostic = snapshots.find(snapshot => {
      try { return JSON.parse(String(snapshot.values['content'])).fingerprint === operation.input.fingerprint; } catch { return false; }
    });
    expect(diagnostic).toBeDefined();
    expect(JSON.parse(String(diagnostic!.values['content']))).toEqual({ rule: operation.input.rule, fingerprint: operation.input.fingerprint, reason: operation.input.reason, about: about.uid });
    expect(diagnostic!.key['digest']).toBe(createHash('sha256').update(String(diagnostic!.values['content']), 'utf8').digest('hex'));
    expect(title.length).toBeGreaterThan(0);
    expect(title.every(assertion => assertion.evidence.includes(diagnostic!.uid))).toBe(true);
    const principals = await owner.run(tx => readKindAssertions(tx, 'vertex', 'person', ['installation'], { contract: withAssertionContract(contract) }));
    expect(principals.some(principal => title.some(assertion => assertion.author === principal.uid))).toBe(true);
  } finally { await owner.close(); }
}, 30_000);

test('concurrent distinct people converge on one fingerprint without losing their authenticated authors', async () => {
  const { owner, about, grant, contract } = await fixture();
  try {
    const uid = newUid();
    await owner.transaction('write', async tx => {
      await startupBinding(tx, contract, 'person-fixture');
      await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'person', uid, key: {}, values: { installation: 'bob-fixture' }, producer: 'system', producerVersion: '1' }], removals: [] });
    });
    const principal = await registerGraphPrincipal(owner, { producer: `person:${uid}`, version: '1', uid, kind: 'person', sourceUid: uid, principalUid: uid, scope: producerIdentityOf(grant).scope });
    const full = withAssertionContract(contract);
    const bob = bindGraphProducer(owner, full, { principal, vertices: Object.fromEntries(full.vertex.filter(kind => ['task', 'system.problem', 'system.content-snapshot'].includes(kind.name)).map(kind => [kind.name, kind.fields.map(field => field.name)])), edges: Object.fromEntries(full.edge.filter(kind => ['task-problem', 'system.problem-about'].includes(kind.name)).map(kind => [kind.name, kind.fields.map(field => field.name)])) });
    const answers = await Promise.all([
      executeManualOperation(owner, person('Alice@work', 'alice@example.test', 'alice-press'), request('concurrent', about), grant),
      executeManualOperation(owner, person('Bob', 'bob@example.test', 'bob-press'), request('concurrent', about), bob),
    ]);
    expect(answers[0]!.uid).toBe(answers[1]!.uid);
    const problems = await owner.run(tx => readKindAssertions(tx, 'vertex', 'system.problem', ['fingerprint'], { contract: withAssertionContract(contract) }));
    expect(problems.filter(row => row.values['fingerprint'] === request('concurrent', about).input.fingerprint)).toHaveLength(1);
    const assertions = await owner.run(tx => loadAssertions(tx, 'vertex', 'task', ['title']));
    expect(new Set(assertions.map(assertion => assertion.author)).size).toBe(2);
    expect(new Set(assertions.map(assertion => assertion.source)).size).toBe(2);
  } finally { await owner.close(); }
}, 30_000);

test('a separator-bearing finding uses a fingerprint and never puts its raw identity in graph scalar values', async () => {
  const { owner, about, grant, contract } = await fixture();
  try {
    const identity = 'sink\u0000builder';
    const fingerprint = problemFingerprint({ rule: 'security.sql-input', reason: 'Untrusted input reaches SQL', file: identity, line: 12 }, about.uid);
    const operation = { ...request(fingerprint, about), input: { ...request(fingerprint, about).input, rule: 'security.sql-input', fingerprint } };
    const answer = await executeManualOperation(owner, person('Alice', 'alice@example.test', 'separator'), operation, grant);
    expect(answer.uid).toBeDefined();
    const rows = await owner.run(tx => readKindAssertions(tx, 'vertex', 'system.problem', ['fingerprint', 'rule'], { contract: withAssertionContract(contract) }));
    expect(rows[0]!.values).toMatchObject({ fingerprint, rule: 'security.sql-input' });
    expect(JSON.stringify(rows[0]!.values)).not.toContain(identity);
    expect(fingerprint).not.toContain('\u0000');
  } finally { await owner.close(); }
}, 30_000);

test('missing semantic binding refuses loudly and leaves no partial problem or task', async () => {
  const { owner, grant, contract } = await fixture(false);
  try {
    await expect(executeManualOperation(owner, person('Alice', 'alice@example.test', 'missing-binding'), request('refused'), grant)).rejects.toThrow('semantic-bindings.problem-task');
    expect(await owner.run(tx => readKindAssertions(tx, 'vertex', 'task', [], { contract: withAssertionContract(contract) }))).toEqual([]);
    expect(await owner.run(tx => readKindAssertions(tx, 'vertex', 'system.problem', [], { contract: withAssertionContract(contract) }))).toEqual([]);
  } finally { await owner.close(); }
}, 30_000);

test('manual task creation requires an authenticated person and stable request identity', async () => {
  const { owner, grant } = await fixture();
  try {
    await expect(executeManualOperation(owner, { producer: 'anonymous', version: '1' }, request('refused'), grant)).rejects.toThrow('authenticated operation request identity');
    await expect(executeManualOperation(owner, { producer: 'anonymous', version: '1', operationId: 'missing-person' }, request('refused'), { ...grant } as ProducerBinding)).rejects.toThrow('host-issued source binding');
  } finally { await owner.close(); }
}, 30_000);

test('the task says what has to change in the product\'s own language', () => {
  const problem = {
    id: 'large-file\u0000code.file:product/src/big.ts', identity: 'code.file:product/src/big.ts', section: 'code' as const,
    rule: 'large-file', kind: 'large-file', sonar: 'code-smell' as const, severity: 'minor' as const,
    fixer: 'person' as const, closed: false,
    place: { label: 'src/big.ts:1', href: '/src?path=src%2Fbig.ts&line=1', key: null }, entity: null, evidence: [],
    page: null, pageTitle: null, statement: null, sentence: null, target: null,
    reason: 'src/big.ts is 731 lines long, over the product\'s 600-line threshold: one module holds too much to change safely.',
    words: { en: '731 lines, over the 600-line threshold.', ru: '731 строка при пороге 600.' },
    file: 'src/big.ts', line: 1, by: null, at: null, scope: { type: 'file' as const, path: 'src/big.ts' },
  };
  const ru = problemTaskRecord(problem, { language: 'ru', label: { en: 'Large file', ru: 'Большой файл' } });
  expect(ru.title).toBe('Исправить: Большой файл — src/big.ts:1');
  expect(ru.body).toBe('Правило: Большой файл\nМесто: src/big.ts:1\nЧто не так: 731 строка при пороге 600.');
  const en = problemTaskRecord(problem, { language: 'en', label: { en: 'Large file' } });
  expect(en.title).toBe('Fix: Large file — src/big.ts:1');
  expect(en.body).toBe('Rule: Large file\nPlace: src/big.ts:1\nWhat is wrong: 731 lines, over the 600-line threshold.');
});


test('Problems page links its graph task, reopens it on a second press, and refuses an unlisted finding', async () => {
  const home = join(root, 'page-products');
  const env = gitEnv({ GIT_AUTHOR_NAME: 'Alice@work', GIT_AUTHOR_EMAIL: 'display@example.test', GIT_COMMITTER_NAME: 'Alice@work', GIT_COMMITTER_EMAIL: 'display@example.test' });
  const draft = createDraft({ home, name: 'page-task', gitEnv: env });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  const storeRoot = knowledgeRootOf(home);
  const closePreparation = await retainTestStorePreparationOwner();
  const { owner, contract } = await fixture(true, { folder: draft.folder, store: storeDatabasePath(productStoreFolder(draft.folder, storeRoot)) });
  const product = new KnowledgeProduct({ productFolder: draft.folder, storeRoot, env });
  try {
    await owner.transaction('write', async tx => {
      const authenticated = await startupBinding(tx, contract, 'fixture');
      bindWriteCapability(tx, authenticated.binding);
      await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'code.file', key: { repository: 'sample', path: 'src/big.ts' }, values: { lines: 731 }, producer: 'fixture', producerVersion: '1' }], removals: [] });
    });
    const before = await product.problems();
    const finding = before.problems.find(problem => problem.rule === 'large-file' && problem.file === 'src/big.ts');
    expect(finding).toBeDefined();
    const first = await product.createProblemTask(finding!.id);
    expect(first.state).toBe('created');
    expect(first.task.href).toMatch(/^\/e\/task\/[0-9a-f-]+$/);
    expect((await product.problems()).problems.find(problem => problem.id === finding!.id)?.task).toEqual(first.task);
    expect(await product.createProblemTask(finding!.id)).toEqual({ state: 'existing', task: first.task });
    const tasks = await owner.run(tx => readKindAssertions(tx, 'vertex', 'task', ['title'], { contract: withAssertionContract(contract) }));
    expect(tasks).toHaveLength(1);
    const authors = await owner.run(tx => readKindAssertions(tx, 'vertex', 'person', ['installation'], { contract: withAssertionContract(contract) }));
    const assertions = await owner.run(tx => loadAssertions(tx, 'vertex', 'task', ['title']));
    const authored = authors.find(author => assertions.some(assertion => assertion.author === author.uid));
    expect(authored?.uid).toBeDefined();
    expect(authored?.values['installation']).not.toContain('authenticated-alice');
    expect(authored?.values['installation']).not.toContain('Alice@work');
    await expect(product.createProblemTask('no-longer-listed')).rejects.toThrow('no longer on the page');
    expect(await owner.run(tx => readKindAssertions(tx, 'vertex', 'task', [], { contract: withAssertionContract(contract) }))).toHaveLength(1);
  } finally { await product.close(); await owner.close(); await closePreparation(); }
}, 60_000);
