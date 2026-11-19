/**
 * The product root without an agent (ALX-469, decision 0039 item 9): the engine's protected `system.product` is a
 * declared prerequisite of the catalogue's kinds, so a product that holds no agent fills through its deterministic
 * plugins and says which agent-filled fields it leaves. A manifest still names its own kinds, and a product producer
 * may not declare a protected engine kind.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { parseKinds, readKinds } from '../src/product/manifest/kinds.js';
import { planManifestFill } from '../src/plugin/fill-declarations.js';
import { makeProduct } from './knowledge-fixture.js';
import { readFolderManifestText, writeFolderManifest } from './catalog-folder-fixture.js';

const files = { has: () => false, text: () => undefined, size: () => null, filesBelow: () => [] as string[] };

test('(b) a kind that derives from product-profile without declaring it is refused with the file and the line', () => {
  const file = '/fixture/madarch/catalog.yaml';
  const text = `kinds:
  code.repository:
    source: graph
    labels:
      en: { one: Repository, many: Repositories }
      ru: { one: Репозиторий, many: Репозитории }
    description:
      en: A repository.
      ru: Репозиторий.
    derives-from: [system.product, product-profile]
    key: [name]
    fields:
      - { name: name, type: text, producers: [person] }
`;
  const manifest = parseKinds(text, file, '/fixture', files);
  const missing = manifest.findings.find((finding) => finding.message.includes('product-profile'));
  expect(missing).toBeDefined();
  expect({ file: missing!.file, line: missing!.line }).toEqual({ file, line: 2 });
  expect(missing!.message).toBe('kind "code.repository": "derives-from" names the kind "product-profile", and the manifest declares no such kind');
  // The installed contract's protected root is a declared prerequisite, not a missing kind.
  expect(manifest.findings.some((finding) => finding.message.includes('system.product'))).toBe(false);
});

test('(c) a plugin that declares the protected system.product output is refused, and the kind stays the engine\'s', () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-protected-output-'));
  try {
    mkdirSync(join(folder, 'plugins/inspector'), { recursive: true });
    writeFileSync(join(folder, 'plugins/inspector/plugin.json'), JSON.stringify({
      name: 'inspector', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: '1.4.2' },
      produces: [{ kind: 'system.product', fields: ['name'], reads: [] }],
    }));
    writeFileSync(join(folder, 'plugins/inspector/contract.json'), JSON.stringify({
      id: 'inspector', version: '1.0.0', outputs: { vertices: [], edges: [] }, rights: { network: 'none', graph: false },
    }));
    const text = `kinds:
  probe.note:
    source: graph
    fields:
      - { name: title, type: text, producers: [person] }
plugins:
  - { id: inspector, version: 1, path: plugins/inspector, inputs: [], outputs: [], closure: [plugins/inspector/plugin.json, plugins/inspector/contract.json] }
`;
    const manifest = parseKinds(text, join(folder, 'madarch/catalog.yaml'), folder, {
      has: (path) => path === 'plugins/inspector/plugin.json' || path === 'plugins/inspector/contract.json',
      text: (path) => path === 'plugins/inspector/plugin.json' ? readFileSync(join(folder, path), 'utf8') : path === 'plugins/inspector/contract.json' ? readFileSync(join(folder, path), 'utf8') : undefined,
      size: () => null,
    });
    expect(() => planManifestFill(manifest, folder, [])).toThrow(/system\.product is a protected system kind/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('(a) a fresh default product without an agent plans its plugins and skips the product fields the agent would fill', () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-root-without-agent-'));
  try {
    const repository = join(root, 'repository');
    mkdirSync(repository);
    const product = makeProduct(join(root, 'products'), 'shop', repository, 'app');
    // The product holds no agent plugin: a person chose none, as a product made without one does.
    const manifest = parseDocument(readFolderManifestText(product));
    manifest.set('plugins', (manifest.toJS().plugins as { id: string }[]).filter((plugin) => plugin.id !== 'agent-fill'));
    writeFolderManifest(product, manifest.toString());
    const lockFile = join(product, 'madarch/plugins.lock');
    const lock = parseDocument(readFileSync(lockFile, 'utf8'));
    lock.set('plugins', (lock.toJS().plugins as { id: string }[]).filter((plugin) => plugin.id !== 'agent-fill'));
    writeFileSync(lockFile, lock.toString());
    const read = readKinds(product);
    expect(read.present).toBe(true);
    if (!read.present) return;
    expect(read.manifest.findings).toEqual([]);
    const plan = planManifestFill(read.manifest, product, undefined, false);
    expect(plan.errors).toEqual([]);
    // The product kind's fields are the agent's alone; without an agent the plan leaves them, and says why.
    expect(plan.skipped.find((skipped) => skipped.kind === 'product')).toEqual({
      kind: 'product', fields: ['name', 'purpose', 'status', 'vision'], reason: 'no producer in the manifest',
    });
    // The deterministic fill reads the tree and its history; the profile is the engine's own, never a plugin unit.
    expect(plan.order).toContain('disk');
    expect(plan.order).toContain('git');
    // The profile is the engine's own applicability write, never a plugin's unit: no producer claims its fields.
    expect(plan.selectedKinds).toContain('product-profile');
    expect([...plan.fieldProducers('product-profile').values()].every((producers) => producers.length === 0)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
