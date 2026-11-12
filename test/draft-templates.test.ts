/**
 * The templates `madarch new` offers (madarch-64o5.3): each one makes a product whose manifest stands in its
 * repository, and whose wiki reads `not-filled` until a person presses Fill; the template that declares no kinds makes
 * a product whose wiki reads `no-manifest`, naming the file. Nothing here fills anything.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKinds } from '../src/product/manifest/kinds.js';
import { starterPageKindNames } from '../src/knowledge/seed.js';
import { STARTER_TEMPLATES, templateMenuLines } from '../src/knowledge/starter-templates.js';
import { checkStarterTemplate } from '../scripts/template-check.js';
import { createDraft } from '../src/product/draft.js';
import { startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

const env = gitEnv(SAMPLE_IDENTITY);
let root = '';
let home = '';
let app = '';
const folders = new Map<string, string>();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madarch-templates-'));
  home = join(root, 'products');
  app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  for (const template of STARTER_TEMPLATES) {
    const draft = createDraft({ home, name: template.id, template: template.id, gitEnv: env });
    if (draft.outcome !== 'created') throw new Error(`the ${template.id} product was not made: ${JSON.stringify(draft)}`);
    expect(draft.template).toBe(template.id);
    folders.set(template.id, draft.folder);
  }
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the templates madarch new offers', () => {
  test('the declared templates are data: a third one, declared here and nowhere in the engine, is made, checked and listed', () => {
    // The list is data, not code: a template this test declares is created, checked and shown in the menu like the two
    // the starter data holds, and no engine file names it.
    const fixture = {
      id: 'fixture',
      title: { en: 'Fixture', ru: 'Стенд' },
      description: { en: 'A template this test declares.', ru: 'Шаблон, объявленный этим тестом.' },
      kinds: ['task'] as const,
    };
    const templates = [...STARTER_TEMPLATES, fixture];
    const home = join(root, 'fixture-home');
    const draft = createDraft({ home, name: 'fixture', template: fixture.id, templates, gitEnv: env });
    if (draft.outcome !== 'created') throw new Error(`the fixture product was not made: ${JSON.stringify(draft)}`);
    expect(draft.kinds).toBe(1);
    const read = readKinds(draft.folder);
    expect(read.present).toBe(true);
    if (read.present) expect([...read.manifest.kinds.keys()]).toEqual(['task']);
    const checked = checkStarterTemplate(fixture);
    expect({ ok: checked.ok, problems: checked.problems }).toEqual({ ok: true, problems: [] });
    expect(checked.kinds).toEqual(['task']);
    const lines = templateMenuLines(templates);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('3. Fixture —');
    // The declared data itself stays two: the fixture above is not starter data.
    expect(STARTER_TEMPLATES.map((template) => template.id)).toEqual(['everything', 'none']);
  });

  test('document expectations name only document-source kinds in generated templates', () => {
    for (const template of STARTER_TEMPLATES) {
      const read = readKinds(folders.get(template.id)!);
      if (!read.present) continue;
      expect(read.manifest.findings.filter((finding) => finding.message.includes('documents.expect'))).toEqual([]);
      for (const entry of read.manifest.expect ?? []) {
        expect(read.manifest.kinds.get(entry.kind)?.source).toBe('document');
      }
    }
  });

  test('each template writes exactly its kinds, and nothing when it declares none', () => {
    for (const template of STARTER_TEMPLATES) {
      const folder = folders.get(template.id)!;
      const read = readKinds(folder);
      if (template.kinds === 'none') {
        expect({ template: template.id, present: read.present }).toEqual({ template: template.id, present: false });
        expect(existsSync(join(folder, 'madarch', 'catalog.yaml'))).toBe(false);
        expect(existsSync(join(folder, 'templates'))).toBe(false);
        continue;
      }
      expect({ template: template.id, present: read.present }).toEqual({ template: template.id, present: true });
      if (!read.present) continue;
      expect(read.manifest.findings).toEqual([]);
      expect([...read.manifest.kinds.keys()].sort()).toEqual([...starterPageKindNames(template)].sort());
    }
  });

  test('a product made from a template reads not-filled before any fill, and a scratch product reads no-manifest', async () => {
    const server = await startPreparedServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    try {
      for (const template of STARTER_TEMPLATES) {
        const answer = await fetch(`${server.url}/products/${encodeURIComponent(template.id)}/api/status`, { headers: { accept: 'application/json' } });
        expect(answer.status).toBe(200);
        const status = (await answer.json()) as { manifest?: string; manifestFile?: string; fill?: { state?: string } };
        const expected = template.kinds === 'none' ? 'no-manifest' : 'not-filled';
        expect({ template: template.id, manifest: status.manifest }).toEqual({ template: template.id, manifest: expected });
        expect(String(status.manifestFile)).toContain(join('madarch', 'catalog.yaml'));
        // The status only offers the fill: nothing has started one.
        expect(status.fill?.state).toBe('idle');
      }
    } finally {
      await server.stop();
    }
  }, 60_000);
});
