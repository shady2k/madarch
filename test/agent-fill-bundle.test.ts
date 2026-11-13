import { starterManifestText } from './catalog-folder-fixture.js';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { BUNDLED_PLUGINS, bundledClosureHash } from '../src/plugin/bundled.js';
import { closureOf, readPluginManifest } from '../src/plugin/closure.js';

describe('the bundled general agent producer', () => {
  test('a catalogue kind without a natural key is refused at its manifest declaration', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fill-key-'));
    try {
      seedStarterSet(root);
      const file = join(root, 'madarch/catalog.yaml');
      const text = `kinds:
  example.keyless:
    template: templates/entity.liquid
    source: graph
    fields:
      - { name: title, type: text, binding: { agent: A title. } }
plugins:
  - { id: agent-fill, version: 1, path: plugins/agent-fill, inputs: [], outputs: [], closure: [plugins/agent-fill/contract.json, plugins/agent-fill/main.ts, plugins/agent-fill/plugin.json, plugins/agent-fill/prompt.md] }
`;
      const manifest = parseKinds(text, file, root);
      expect(manifest.findings).toContainEqual(expect.objectContaining({ file, source: file, line: 2, message: expect.stringContaining('example.keyless') }));
      expect(manifest.findings.some((finding) => finding.message.includes('"key"'))).toBe(true);
      expect(manifest.plugins?.get('agent-fill')?.contract?.vertices.some((vertex) => vertex.kind === 'example.keyless')).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('manifest-derived outputs preserve contracts and omit kinds with deterministic producers', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fill-contract-'));
    try {
      seedStarterSet(root);
      const document = parse(starterManifestText());
      const { terms: _terms, semantics: _semantics, ...base } = document.kinds['doc.term'];
      document.kinds['example.topic'] = {
        ...base, id: 'example.topic', definition: 'A topic supported by graph evidence.',
        template: 'templates/entity.liquid', source: 'graph',
        description: { en: 'A topic supported by graph evidence.', ru: 'A topic supported by graph evidence.' },
        fields: [
          { name: 'name', type: 'text', binding: { agent: 'The topic name stated in the source.' } },
          { name: 'note', type: 'text', nullable: true, evidence: false, binding: { agent: 'An optional explanation.' } },
        ],
        key: ['name'], 'depends-on': ['code.file'],
      };
      document.kinds['example.static'] = {
        ...base, id: 'example.static', definition: 'A statically extracted fact.',
        template: 'templates/entity.liquid', source: 'graph', capability: 'git',
        fields: [{ name: 'name', type: 'text', binding: { agent: 'A name.' } }], key: ['name'],
      };
      const manifest = parseKinds(stringify(document), 'madarch/catalog.yaml', root);
      expect(manifest.findings).toEqual([]);
      const plugin = manifest.plugins?.get('agent-fill');
      expect(plugin?.outputs).toContain('example.topic');
      expect(plugin?.outputs).not.toContain('example.static');
      expect(plugin?.outputs).not.toContain('code.file');
      expect(plugin?.outputs).not.toContain('code.table');
      expect(plugin?.outputs).not.toContain('doc.term');
      expect(plugin?.contract?.vertices.find((vertex) => vertex.kind === 'example.topic')).toEqual({
        kind: 'example.topic', key: ['name'], fields: [
          { name: 'name', type: 'text', meaning: 'The topic name stated in the source.', example: null, required: true, evidence: true },
          { name: 'note', type: 'text', meaning: 'An optional explanation.', example: null, required: false, evidence: false },
        ],
      });
      expect(manifest.kinds.get('example.topic')?.dependsOn).toEqual(['code.file']);
      expect(manifest.kinds.get('example.topic')?.descriptions?.en).toBe('A topic supported by graph evidence.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a new product holds its prompt and the exact release closure', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fill-bundle-'));
    try {
      const files = seedStarterSet(root);
      const bundled = BUNDLED_PLUGINS.find((plugin) => plugin.id === 'agent-fill');
      if (bundled === undefined) throw new Error('The release carries no general agent producer');
      expect(files).toContain('plugins/agent-fill/prompt.md');
      const folder = join(root, bundled.folder);
      expect(closureOf(folder).hash).toBe(bundledClosureHash(bundled));
      const manifest = readPluginManifest(folder);
      expect(manifest.agent).toEqual({ prompt: 'prompt.md', roots: ['.'], catalogue: true });
      expect(readFileSync(join(folder, manifest.agent!.prompt), 'utf8').length).toBeGreaterThan(0);
      const lock = parse(readFileSync(join(root, 'madarch/plugins.lock'), 'utf8')) as { plugins: { id: string; closure: string }[] };
      expect(lock.plugins.find((plugin) => plugin.id === bundled.id)?.closure).toBe(closureOf(folder).hash);
      const kinds = parse(readFileSync(join(root, 'madarch/catalog.yaml'), 'utf8')) as { plugins: { id: string; inputs: string[]; outputs: string[] }[] };
      expect(kinds.plugins.find((plugin) => plugin.id === bundled.id)).toMatchObject({ inputs: [], outputs: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
