import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestDatabaseOwner } from './test-database.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { manifestDeclaration, withManifestContract } from '../src/graph/manifest-contract.js';
import { EMPTY_CONTRACT, generatedTableName } from '../src/graph/contract.js';
import { validateProductManifests, publishValidatedManifests, readPublishedManifest } from '../src/graph/manifest-publication.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { createManifestWatch } from '../src/product/manifest-watch.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { graphqlSchemaOf } from '../src/graphql/schema.js';
import { readKindAssertions } from '../src/graph/records.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { bindWriteCapability, publishGraphDrafts } from '../src/graph/write.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { personBinding } from '../src/graph/system-installation.js';
import { activateGraphProducer, bindGraphProducer, registerGraphPrincipal } from '../src/graph/producer-binding.js';
import { newUid } from '../src/graph/uid.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-manifest-publication-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function fixture(): string {
  const folder = mkdtempSync(join(root, 'product-'));
  mkdirSync(join(folder, 'madarch'));
  mkdirSync(join(folder, 'templates'));
  writeFileSync(join(folder, 'templates', 'term.md'), '# Term');
  writeFolderManifest(folder, `kinds:
  term:
    source: document
    
    terms: ["docs/*.md"]
`);
  writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  future: { status: planned, stages: [] }\n');
  execFileSync('git', ['init', '-q', folder]);
  execFileSync('git', ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '--allow-empty', '-qm', 'fixture']);
  return folder;
}

test('publishes complete metadata and declaration evidence without repository content or fill', async () => {
  const folder = fixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    const read = validateProductManifests(folder);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(JSON.stringify(read.findings));
    if (read.value === undefined) throw new Error('fixture manifest was absent');
    expect(await publishValidatedManifests(owner, read.value)).toBeGreaterThan(0);
    const manifest = await owner.run((tx) => readPublishedManifest(tx));
    expect([...manifest!.kinds.keys()]).toEqual(['term']);
    expect([...manifest!.workflows!.workflows.keys()]).toEqual(['future']);
    const rows = await owner.run(tx => loadAssertions(tx, 'vertex', 'manifest.kind', ['declaration']));
    const kind = rows.at(-1)!;
    expect(kind.evidence).toHaveLength(1);
    const snapshots = await owner.run(tx => readKindAssertions(tx, 'vertex', 'system.content-snapshot', ['content']));
    const snapshot = snapshots.find(row => row.uid === kind.evidence[0])!;
    expect(snapshot.values['content']).toContain('term');
    const locators = await owner.run(tx => tx.query<{ discriminator: string }>(`SELECT e.discriminator FROM edge e JOIN node a ON a.id=e.from_node JOIN entity k ON k.id=e.entity_id WHERE a.uid=$1::uuid AND k.name='system.assertion-evidence'`, [kind.id]));
    expect(JSON.parse(locators.rows[0]!.discriminator).locator).toMatchObject({ lineStart: 1, lineEnd: 1 });
    expect(await publishValidatedManifests(owner, read.value)).toBe(0);
    const regrounded = { ...read.value, vertices: read.value.vertices.map(one => ({ ...one, evidence: one.evidence?.map(e => ({ ...e, locator: { ...e.locator, lineStart: 2, lineEnd: 2 } })) })) };
    expect(await publishValidatedManifests(owner, regrounded)).toBeGreaterThan(0);
    const grounds = await owner.run(tx => loadAssertions(tx, 'vertex', 'manifest.kind', ['declaration']));
    expect(grounds.at(-1)!.evidence).toEqual(kind.evidence);
    const changedLocators = await owner.run(tx => tx.query<{ discriminator: string }>(`SELECT e.discriminator FROM edge e JOIN node a ON a.id=e.from_node JOIN entity k ON k.id=e.entity_id WHERE a.uid=$1::uuid AND k.name='system.assertion-evidence'`, [grounds.at(-1)!.id]));
    expect(JSON.parse(changedLocators.rows[0]!.discriminator).locator).toMatchObject({ lineStart: 2, lineEnd: 2 });
    expect(await publishValidatedManifests(owner, regrounded)).toBe(0);
    const edited = { ...regrounded, vertices: regrounded.vertices.map((one) => one.kind === 'manifest.kind' ? { ...one, values: { declaration: JSON.stringify({ ...JSON.parse(String(one.values!['declaration'])), title: 'Changed title' }) } } : one) };
    expect(await publishValidatedManifests(owner, edited)).toBeGreaterThan(0);
    const declaration = await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.kind', ['declaration']));
    expect(JSON.parse(String(declaration[0]!.values['declaration']))).toMatchObject({ title: 'Changed title' });
    expect(await publishValidatedManifests(owner, edited)).toBe(0);
    // An older matching opinion is closed history, not proof that the latest declaration is unchanged.
    expect(await publishValidatedManifests(owner, regrounded)).toBeGreaterThan(0);
    expect(await publishValidatedManifests(owner, regrounded)).toBe(0);
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    expect((await owner.run((tx) => readPublishedManifest(tx)))!.kinds.size).toBe(1);
    const contents = await owner.run((tx) => tx.query<{ count: string }>("SELECT count(*)::text AS count FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name LIKE 'code.%'"));
    expect(contents.rows[0]!.count).toBe('0');
  } finally { await owner.close(); }
}, 30_000);


test('workflow stages are protected metadata with parent edges, identities and declaration evidence', async () => {
  const folder = fixture();
  writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  alpha: { status: planned, stages: [plugin-turns] }\n  beta: { status: planned, stages: [plugin-turns] }\n');
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    const read = validateProductManifests(folder);
    if (!read.ok || read.value === undefined) throw new Error(JSON.stringify(read));
    expect(read.value.manifest.kinds.has('manifest.workflow-stage')).toBe(false);
    const stage = manifestDeclaration('workflow-stage');
    const parent = manifestDeclaration('workflow');
    const edge = stage.keyEdges![0]!;
    expect(read.value.vertices.filter(draft => draft.kind === stage.name)).toHaveLength(2);
    expect(await publishValidatedManifests(owner, read.value)).toBeGreaterThan(0);
    const rows = await owner.run(tx => readKindAssertions(tx, 'vertex', stage.name, ['position', 'declaration']));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.uid)).size).toBe(2);
    expect(rows.map(row => row.values['position'])).toEqual([0, 0]);
    const relations = await owner.run(tx => tx.query<{ stage: string; workflow: string; kind: string }>(`SELECT s.uid::text AS stage,p.key->>'name' AS workflow,pk.name AS kind FROM edge e JOIN entity ek ON ek.id=e.entity_id JOIN node s ON s.id=e.from_node JOIN node p ON p.id=e.to_node JOIN entity pk ON pk.id=p.entity_id WHERE ek.name=$1 ORDER BY workflow`, [edge.edge]));
    expect(relations.rows.map(row => [row.workflow, row.kind])).toEqual([['alpha', parent.name], ['beta', parent.name]]);
    const lineage = await owner.run(tx => loadAssertions(tx, 'vertex', stage.name, ['position']));
    expect(lineage).toHaveLength(2);
    expect(lineage.every(assertion => assertion.evidence.length === 1)).toBe(true);
    expect(await publishValidatedManifests(owner, read.value)).toBe(0);
    writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  alpha: { status: planned, stages: [plugin-turns] }\n  beta: { status: planned, stages: [] }\n');
    const changed = validateProductManifests(folder);
    if (!changed.ok || changed.value === undefined) throw new Error(JSON.stringify(changed));
    expect(await publishValidatedManifests(owner, changed.value)).toBeGreaterThan(0);
    const remaining = await owner.run(tx => readKindAssertions(tx, 'vertex', stage.name, ['position']));
    expect(remaining.map(row => row.uid)).toEqual([relations.rows[0]!.stage]);
    expect(await publishValidatedManifests(owner, changed.value)).toBe(0);
  } finally { await owner.close(); }
}, 30_000);

test('reports all invalid declarations with full paths and retains the last valid publication on refresh', async () => {
  const folder = fixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  const reports: string[] = [];
  const watch = createManifestWatch([], async (value) => { await publishValidatedManifests(owner, value); }, (line) => reports.push(line));
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    await watch.refresh(folder);
    writeFolderManifest(folder, 'kinds:\n  bad: { source: unknown, template: missing.md }\n');
    writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  broken: { status: wrong, stages: [unknown] }\n');
    const read = validateProductManifests(folder);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('invalid manifests accepted');
    expect(read.findings.some((one) => one.file === join(folder, 'madarch/kinds/fixture/fixture/bad.yaml'))).toBe(true);
    expect(read.findings.some((one) => one.file === join(folder, 'madarch', 'workflows.yaml'))).toBe(true);
    expect(read.findings.every((one) => one.line > 0)).toBe(true);
    await watch.refresh(folder);
    expect(reports.length).toBeGreaterThan(1);
    expect([...((await owner.run((tx) => readPublishedManifest(tx)))!.kinds.keys())]).toEqual(['term']);
    writeFolderManifest(folder, 'kinds: {}\n');
    writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows: {}\n');
    await watch.refresh(folder);
    expect((await owner.run((tx) => readPublishedManifest(tx)))!.kinds.size).toBe(0);
    const rows = await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.kind', []));
    expect(rows).toEqual([]);
  } finally { watch.stop(); await owner.close(); }
}, 30_000);

test('filesystem watcher publishes a valid edit and refuses invalid edits without losing metadata', async () => {
  const folder = fixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  const reports: string[] = [];
  let publications = 0;
  let resolvePublished: (() => void) | undefined;
  let resolveRefused: (() => void) | undefined;
  const watcher = createManifestWatch([folder], async (value) => {
    await publishValidatedManifests(owner, value);
    publications++;
    resolvePublished?.();
  }, (line) => { reports.push(line); resolveRefused?.(); });
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    await watcher.refresh(folder);
    const published = new Promise<void>((done) => { resolvePublished = done; });
    writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  later: { status: planned, stages: [] }\n');
    await published;
    expect((await owner.run((tx) => readPublishedManifest(tx)))!.workflows!.workflows.has('later')).toBe(true);
    resolvePublished = undefined;
    const refused = new Promise<void>((done) => { resolveRefused = done; });
    writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  invalid: { status: incorrect }\n');
    await refused;
    expect(reports.some((line) => line.includes('workflows.yaml:2:'))).toBe(true);
    expect((await owner.run((tx) => readPublishedManifest(tx)))!.workflows!.workflows.has('later')).toBe(true);
    expect(publications).toBeGreaterThan(1);
  } finally { watcher.stop(); await owner.close(); }
}, 30_000);

test('a home watcher discovers the current folder when the startup folder has already moved', async () => {
  const folder = fixture();
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: startup-fixture\nname: fixture\n');
  const moved = join(root, 'startup-renamed');
  renameSync(folder, moved);
  const publications: string[] = [];
  const watcher = createManifestWatch([folder], async (value) => { publications.push(value.folder); }, () => {}, root);
  try {
    for (let tries = 0; tries < 200 && !publications.includes(moved); tries++) await Bun.sleep(25);
    expect(publications, `${moved}:1: the startup rename was not published`).toContain(moved);
    writeFileSync(join(moved, 'madarch', 'workflows.yaml'), 'workflows: {}\n');
    const before = publications.length;
    for (let tries = 0; tries < 200 && publications.length === before; tries++) await Bun.sleep(25);
    expect(publications.length, `${moved}:1: the startup rename was not watched`).toBeGreaterThan(before);
  } finally { watcher.stop(); }
}, 15_000);

test('a home watcher follows a renamed product and keeps its watch while its identity needs repair', async () => {
  const folder = fixture();
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: fixture\nname: fixture\n');
  const moved = join(root, 'renamed');
  const publications: string[] = [];
  const reports: string[] = [];
  const watcher = createManifestWatch([folder], async (value) => { publications.push(value.folder); }, (line) => reports.push(line), root);
  const until = async (ready: () => boolean): Promise<void> => {
    for (let tries = 0; tries < 200; tries++) {
      if (ready()) return;
      await Bun.sleep(25);
    }
    throw new Error(`${moved}:1: watcher did not settle: ${reports.join('; ')}`);
  };
  try {
    renameSync(folder, moved);
    await until(() => publications.includes(moved));
    writeFileSync(join(moved, 'workspace.yaml'), 'schemaVersion: 1\nid: [invalid\n');
    // A change to the home asks discovery to read the broken identity.
    const signal = join(root, 'signal'); mkdirSync(signal);
    await until(() => reports.some((line) => line.includes(`${moved}/workspace.yaml:2:`)));
    const before = publications.length;
    writeFileSync(join(moved, 'workspace.yaml'), 'schemaVersion: 1\nid: fixture\nname: repaired\n');
    writeFileSync(join(moved, 'madarch', 'workflows.yaml'), 'workflows: {}\n');
    await until(() => publications.length > before);
    expect(publications.slice(before)).toContain(moved);
    expect(reports.some((line) => line.includes(`${moved}/workspace.yaml:2:`))).toBe(true);
  } finally { watcher.stop(); }
}, 15_000);

test('malformed kinds still reports workflow and lock diagnostics, and no commit is refused', () => {
  const folder = fixture();
  writeFileSync(join(folder, 'madarch/catalog.yaml'), 'groups: [');
  writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows: [');
  writeFileSync(join(folder, 'madarch', 'plugins.lock'), 'plugins: [');
  const invalid = validateProductManifests(folder);
  expect(invalid.ok).toBe(false);
  if (invalid.ok) throw new Error('invalid manifests accepted');
  for (const name of ['catalog.yaml', 'workflows.yaml', 'plugins.lock']) expect(invalid.findings.some((one) => one.file === join(folder, 'madarch', name))).toBe(true);
  const fresh = fixture();
  rmSync(join(fresh, '.git'), { recursive: true });
  const noCommit = validateProductManifests(fresh);
  expect(noCommit.ok).toBe(false);
  if (noCommit.ok) throw new Error('no commit accepted');
  expect(noCommit.findings[0]!.file).toBe(join(fresh, '.git', 'HEAD'));
});

test('an absent kinds manifest is valid without publishing a catalogue, but invalid declarations still refuse', () => {
  const folder = fixture();
  rmSync(join(folder, 'madarch', 'catalog.yaml'));
  rmSync(join(folder, 'madarch/kinds'), { recursive: true, force: true });
  expect(validateProductManifests(folder)).toEqual({ ok: true, value: undefined });
  writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows: [');
  const invalid = validateProductManifests(folder);
  expect(invalid.ok).toBe(false);
  if (invalid.ok) throw new Error('invalid workflow accepted without kinds');
  expect(invalid.findings.some((one) => one.file === join(folder, 'madarch', 'workflows.yaml'))).toBe(true);
});

test('named plugin manifests use the existing plugin validator for missing and malformed files', () => {
  const folder = fixture();
  mkdirSync(join(folder, 'plugins', 'words'), { recursive: true });
  writeFolderManifest(folder, `plugins:
  - id: words
    version: "1"
    path: plugins/words
    inputs: [term]
    outputs: [term]
    closure: [main.ts]
kinds:
  term:
    source: document
    
    terms: ["docs/*.md"]
`);
  const file = join(folder, 'plugins', 'words', 'plugin.json');
  const missing = validateProductManifests(folder);
  expect(missing.ok).toBe(false);
  if (missing.ok) throw new Error('missing plugin accepted');
  expect(missing.findings.some((one) => one.file === file)).toBe(true);
  writeFileSync(file, '{ "name": 7 }');
  const malformed = validateProductManifests(folder);
  expect(malformed.ok).toBe(false);
  if (malformed.ok) throw new Error('malformed plugin accepted');
  expect(malformed.findings.some((one) => one.file === file && one.line === 1 && one.message.length > 0)).toBe(true);
});

test('the published declarations answer before any fill, even after the checkout changes', async () => {
  const folder = fixture();
  writeFolderManifest(folder, `properties:
  summary: { en: Summary, ru: Описание }
kinds:
  term:
    source: document
    
    terms: ["docs/*.md"]
    details: [summary]
    fields:
      - { name: summary, type: text, producers: [reader] }
`);
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    const validated = validateProductManifests(folder);
    if (!validated.ok || validated.value === undefined) throw new Error(JSON.stringify(validated));
    await publishValidatedManifests(owner, validated.value);
    writeFolderManifest(folder, 'kinds: {}');
    const manifest = (await owner.run((tx) => readPublishedManifest(tx)))!;
    // The graph's published manifest is the one that answers: the checkout's later edit changes nothing.
    expect([...manifest.kinds.keys()]).toEqual(['term']);
    expect(manifest.kinds.get('term')?.fields?.map((field) => field.name)).toEqual(['summary']);
    expect(graphqlSchemaOf(publishedManifestOf(manifest))).toContain('type KindTerm implements Entity');
    const contents = await owner.run((tx) => tx.query<{ count: string }>("SELECT count(*)::text AS count FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = 'code.file'"));
    expect(contents.rows[0]!.count).toBe('0');
  } finally { await owner.close(); }
}, 30_000);

test('purpose labels and order publish through the manifest watcher without a fill', async () => {
  const folder = fixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  const reports: string[] = [];
  const watch = createManifestWatch([], async (value) => { await publishValidatedManifests(owner, value); }, (line) => reports.push(line));
  const declaration = (label: string, order: number) => `purposes:
  understand: { labels: { en: ${label}, ru: Понять }, order: ${order} }
kinds:
  term:
    purpose: understand
    source: document
    
    terms: ["docs/*.md"]
`;
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    writeFolderManifest(folder, declaration('Understand', 10));
    await watch.refresh(folder);
    let published = await owner.run((tx) => readPublishedManifest(tx));
    expect(published?.kinds.get('term')?.purpose).toBe('understand');
    expect(published?.purposes?.get('understand')?.labels.en).toBe('Understand');
    writeFolderManifest(folder, declaration('Read first', 50));
    await watch.refresh(folder);
    published = await owner.run((tx) => readPublishedManifest(tx));
    expect(published?.purposes?.get('understand')?.labels.en).toBe('Read first');
    expect(published?.purposes?.get('understand')?.order).toBe(50);
    expect(reports).toEqual([]);
  } finally { watch.stop(); await owner.close(); }

}, 30_000);

test('startup binding keeps product, source and principal identities and renews only the operation', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    const first = await owner.transaction('write', tx => startupBinding(tx, withManifestContract(EMPTY_CONTRACT), 'manifest'));
    const second = await owner.transaction('write', tx => startupBinding(tx, withManifestContract(EMPTY_CONTRACT), 'manifest'));
    for (const key of ['productUid', 'sourceUid', 'principalUid'] as const) {
      expect(second.binding[key]).toBe(first.binding[key]);
      expect(first.binding[key][14]).toBe('7');
    }
    expect(second.binding.operationUid).not.toBe(first.binding.operationUid);
    expect(first.binding.operationUid[14]).toBe('7');
    const other = await owner.transaction('write', tx => startupBinding(tx, withManifestContract(EMPTY_CONTRACT), 'start'));
    expect(other.binding.productUid).toBe(first.binding.productUid);
    expect(other.binding.principalUid).toBe(other.binding.sourceUid);
    expect(other.binding.principalUid).not.toBe(first.binding.principalUid);
    expect(other.binding.sourceUid).not.toBe(first.binding.sourceUid);
    const personContract = withAssertionContract(withManifestContract(EMPTY_CONTRACT));
    const personGrant = await personBinding(owner, personContract);
    const person = { binding: await owner.transaction('write', tx => activateGraphProducer(tx, personContract, personGrant)) };
    const samePersonGrant = await personBinding(owner, personContract);
    const samePerson = { binding: await owner.transaction('write', tx => activateGraphProducer(tx, personContract, samePersonGrant)) };
    expect(person.binding.principalUid).toBe(samePerson.binding.principalUid);
    expect(person.binding.principalUid).not.toBe(first.binding.principalUid);
    expect(person.binding.principalUid[14]).toBe('7');
    expect(person.binding.sourceUid).toBe(person.binding.principalUid);
    expect(samePerson.binding.sourceUid).toBe(person.binding.sourceUid);
    expect(person.binding.sourceUid).not.toBe(first.binding.sourceUid);
    const identity = await owner.run(tx => tx.query<{ kind: string }>('SELECT k.name AS kind FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid', [person.binding.principalUid]));
    expect(identity.rows).toEqual([{ kind: 'person' }]);
  } finally { await owner.close(); }
});

test('plugin release changes preserve one source while distinct actors persist across store sessions', async () => {
  const contract = { vertex: [{ name: 'fixture.release', table: generatedTableName('fixture.release', 'vertex'), capability: 'fixture', key: ['name'], fields: [{ name: 'name', type: 'text' as const }, { name: 'observed', type: 'text' as const }] }], edge: [], dictionary: [] };
  const options = { store: mkdtempSync(join(root, 'identities-')), graphContract: contract };
  let owner = await createTestDatabaseOwner(options);
  const actorContract = withAssertionContract(contract);
  const actorBinding = async (installation: string) => {
    const uid = await owner.transaction('write', async tx => {
      await startupBinding(tx, actorContract, 'fixture-person-installer');
      const found = (await readKindAssertions(tx, 'vertex', 'person', ['installation'])).filter(row => row.values['installation'] === installation);
      if (found.length > 1) throw new Error(`${import.meta.path}:390: duplicate fixture person ${installation}`);
      const uid = found[0]?.uid ?? newUid();
      await publishGraphDrafts(tx, actorContract, { vertices: [{ kind: 'person', uid, key: {}, values: { installation, label: installation, scope: 'fixture', version: '1' }, producer: 'fixture-person-installer', producerVersion: '1' }], removals: [] });
      return uid;
    });
    const principal = await registerGraphPrincipal(owner, { producer: `person:${uid}`, version: '1', uid, kind: 'person', sourceUid: uid, principalUid: uid, scope: 'fixture' });
    const grant = bindGraphProducer(owner, actorContract, { principal, vertices: { 'fixture.release': ['name', 'observed'] }, edges: {} });
    return { binding: await owner.transaction('write', tx => activateGraphProducer(tx, actorContract, grant)) };
  };
  try {
    const release = async (version: string) => await owner.transaction('write', async tx => {
      const authenticated = await startupBinding(tx, contract, 'fixture-plugin');
      bindWriteCapability(tx, authenticated.binding);
      await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'fixture.release', key: { name: 'release' }, values: { observed: version }, producer: 'fixture-plugin', producerVersion: version }], removals: [] });
      return authenticated.binding;
    });
    const first = await release('1.0.0');
    const upgraded = await release('2.0.0');
    expect(upgraded.sourceUid).toBe(first.sourceUid);
    expect(upgraded.principalUid).toBe(first.principalUid);
    const firstPerson = await actorBinding('first-person');
    const secondPerson = await actorBinding('second-person');
    expect(secondPerson.binding.principalUid).not.toBe(firstPerson.binding.principalUid);
    expect(secondPerson.binding.sourceUid).toBe(secondPerson.binding.principalUid);
    expect(secondPerson.binding.sourceUid).not.toBe(firstPerson.binding.sourceUid);
    expect(firstPerson.binding.sourceUid).not.toBe(first.sourceUid);
    const assertions = await owner.run(tx => loadAssertions(tx, 'vertex', 'fixture.release', ['observed']));
    expect(assertions.map(assertion => assertion.value)).toEqual(['1.0.0', '2.0.0']);
    expect(new Set(assertions.map(assertion => assertion.source))).toEqual(new Set([first.sourceUid]));
    await owner.close();
    owner = await createTestDatabaseOwner(options);
    const reopened = await owner.transaction('write', tx => startupBinding(tx, contract, 'fixture-plugin'));
    const reopenedFirst = await actorBinding('first-person');
    const reopenedSecond = await actorBinding('second-person');
    expect(reopened.binding.productUid).toBe(first.productUid);
    expect(reopened.binding.sourceUid).toBe(first.sourceUid);
    expect(reopened.binding.principalUid).toBe(first.principalUid);
    expect(reopenedFirst.binding.principalUid).toBe(firstPerson.binding.principalUid);
    expect(reopenedSecond.binding.principalUid).toBe(secondPerson.binding.principalUid);
    expect(reopenedSecond.binding.principalUid).not.toBe(reopenedFirst.binding.principalUid);
  } finally { await owner.close(); }
}, 30_000);
