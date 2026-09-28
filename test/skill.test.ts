import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkModel } from '../src/check/model-check.js';
import { GIT_ENV, Repo, withRepo } from './model-check-repo.js';

/**
 * The write-intended-model skill (madarch-utk.2.1): its instructions
 * name themselves in the Agent Skills frontmatter, its format reference
 * documents every field the published schema defines for evidence,
 * elements, interfaces and relations, and its worked example is a real
 * model — the test commits the example repository, substitutes the
 * placeholder commit and blob ids with the real ones the way a run
 * computes them, and the model check passes with views rendered.
 */

const SKILL_DIR = join(import.meta.dir, '..', 'skills', 'write-intended-model');
const EXAMPLE_DIR = join(SKILL_DIR, 'example');

const SCHEMA: {
  properties: {
    elements: { items: { properties: Record<string, unknown> & { evidence: { items: { properties: Record<string, unknown> } } } } };
    interfaces: { items: { properties: Record<string, unknown> } };
    relations: { items: { properties: Record<string, unknown> } };
  };
} = JSON.parse(readFileSync(join(import.meta.dir, '..', 'schema', 'intended-model.schema.json'), 'utf8'));

/** The fields each section of reference.md must document, taken from the published schema. */
const DOCUMENTED_FIELDS: Record<string, string[]> = {
  Element: Object.keys(SCHEMA.properties.elements.items.properties),
  Interface: Object.keys(SCHEMA.properties.interfaces.items.properties),
  Relation: Object.keys(SCHEMA.properties.relations.items.properties),
  Evidence: Object.keys(SCHEMA.properties.elements.items.properties.evidence.items.properties),
};

/** The text of one `## <heading>` section of reference.md, up to the next level-2 heading. */
function sectionOf(reference: string, heading: string): string {
  const start = reference.indexOf(`## ${heading}\n`);
  if (start < 0) throw new Error(`reference.md has no "## ${heading}" section`);
  const next = reference.indexOf('\n## ', start + 1);
  return next < 0 ? reference.slice(start) : reference.slice(start, next);
}

/** The parsed shape of the example's model.yaml the update tests compare by id. */
interface ExampleEvidence {
  file: string;
  line?: number;
  endLine?: number;
  commit?: string;
  blob?: string;
}

interface ExampleModel {
  elements?: { id: string; kind?: string; name?: string; parent?: string; technology?: string; zones?: unknown; evidence?: ExampleEvidence[] }[];
  interfaces?: { id: string; provider?: string; contract?: string; evidence?: ExampleEvidence[] }[];
  relations?: { id: string; name?: string; from?: string; to?: string; interface?: string; action?: string; evidence?: ExampleEvidence[] }[];
}

/**
 * Commits the example repository and its model the way the existing
 * test does — first the code with the placeholder model, then the model
 * with the placeholders substituted — and returns what the update
 * builds on: the commit the base model's evidence pins, the base the
 * branch starts from, and the base substitution for comparisons.
 */
function baseExample(repo: Repo): { pinned: string; base: string; substituteBase: (text: string) => string } {
  cpSync(join(EXAMPLE_DIR, 'repo'), repo.path, { recursive: true });
  cpSync(join(EXAMPLE_DIR, 'madarch'), join(repo.path, 'madarch'), { recursive: true });
  const code = repo.commit('the receipts archiver');
  const substituteBase = (text: string): string =>
    text
      .replace(/BLOB:([A-Za-z0-9][A-Za-z0-9._/-]*)/g, (_: string, file: string) => repo.blob(file, code))
      .replaceAll('COMMIT', code);
  for (const name of ['model.yaml', 'review.md']) {
    writeFileSync(join(repo.path, 'madarch', name), substituteBase(readFileSync(join(EXAMPLE_DIR, 'madarch', name), 'utf8')));
  }
  return { pinned: code, base: repo.commit('the model of the receipts repository'), substituteBase };
}

/**
 * Substitutes the update example's placeholders: BRANCH_COMMIT and
 * BRANCH_BLOB with the branch's ids (the update's evidence pins the
 * branch), BASE_SHORT and HEAD_SHORT with the range's short hashes, and
 * the base placeholders with the commit the first run pinned. The
 * BRANCH_ tokens go first: BLOB: and COMMIT are their suffixes.
 */
function substituteUpdate(text: string, repo: Repo, pinned: string, base: string, head: string): string {
  return text
    .replaceAll('BASE_SHORT', base.slice(0, 7))
    .replaceAll('HEAD_SHORT', head.slice(0, 7))
    .replace(/BRANCH_BLOB:([A-Za-z0-9][A-Za-z0-9._/-]*)/g, (_: string, file: string) => repo.blob(file, head))
    .replaceAll('BRANCH_COMMIT', head)
    .replace(/BLOB:([A-Za-z0-9][A-Za-z0-9._/-]*)/g, (_: string, file: string) => repo.blob(file, pinned))
    .replaceAll('COMMIT', pinned);
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

describe('the write-intended-model skill', () => {
  test('names itself and says when to use it in the Agent Skills frontmatter', () => {
    const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill);
    expect(match).not.toBeNull();
    const meta = parseYaml(match![1]!) as Record<string, unknown>;
    expect(meta['name']).toBe('write-intended-model');
    const description = meta['description'];
    expect(typeof description).toBe('string');
    expect((description as string).trim().length).toBeGreaterThan(0);
  });

  test('documents every schema field of evidence, element, interface and relation', () => {
    const reference = readFileSync(join(SKILL_DIR, 'reference.md'), 'utf8');
    for (const [heading, fields] of Object.entries(DOCUMENTED_FIELDS)) {
      const text = sectionOf(reference, heading);
      for (const field of fields) {
        expect(text.includes(`\`${field}\``), `the "## ${heading}" section of reference.md does not document \`${field}\``).toBe(true);
      }
    }
  });

  test('checks the worked example: substituted placeholders, a passing check, rendered views', () => {
    withRepo((repo) => {
      cpSync(join(EXAMPLE_DIR, 'repo'), repo.path, { recursive: true });
      cpSync(join(EXAMPLE_DIR, 'madarch'), join(repo.path, 'madarch'), { recursive: true });
      const base = repo.commit('the receipts archiver');

      // The placeholders stand for what a real run computes: the commit
      // every item pins (the HEAD the code was committed at) and each
      // named file's blob at that commit.
      for (const name of ['model.yaml', 'review.md']) {
        const path = join(repo.path, 'madarch', name);
        const substituted = readFileSync(path, 'utf8')
          .replace(/BLOB:([A-Za-z0-9][A-Za-z0-9._/-]*)/g, (_: string, file: string) => repo.blob(file, base))
          .replaceAll('COMMIT', base);
        writeFileSync(path, substituted);
      }
      repo.commit('the model of the receipts repository');

      const views = join(repo.path, 'madarch', 'views');
      const report = checkModel(repo.path, { views });
      expect(report.outcome).toBe('passed');
      expect(report.errors).toEqual([]);
      expect(report.stale).toEqual([]);
      expect(existsSync(join(views, 'mermaid', '_landscape.md'))).toBe(true);
    });
  });
});

describe('the write-intended-model skill updating a model', () => {
  test('a branch that adds a folder the core imports: the example update passes with the element added and the rest unchanged', () => {
    withRepo((repo) => {
      const { pinned, base, substituteBase } = baseExample(repo);

      // The branch: the update's repository changes, committed.
      cpSync(join(EXAMPLE_DIR, 'update', 'repo'), repo.path, { recursive: true });
      const head = repo.commit('export receipts as JSON Lines');

      // The model and report the update writes, with the branch's real ids.
      for (const name of ['model.yaml', 'review.md']) {
        const text = readFileSync(join(EXAMPLE_DIR, 'update', 'madarch', name), 'utf8');
        writeFileSync(join(repo.path, 'madarch', name), substituteUpdate(text, repo, pinned, base, head));
      }

      const views = join(repo.path, 'madarch', 'views');
      const report = checkModel(repo.path, { views });
      expect(report.outcome).toBe('passed');
      expect(report.errors).toEqual([]);
      expect(report.stale).toEqual([]);

      // Every id the base model holds and the change does not concern
      // is present, unchanged, in the updated model; the change adds
      // exactly the export element and relation.
      const baseModel = parseYaml(substituteBase(readFileSync(join(EXAMPLE_DIR, 'madarch', 'model.yaml'), 'utf8'))) as ExampleModel;
      const updated = parseYaml(readFileSync(join(repo.path, 'madarch', 'model.yaml'), 'utf8')) as ExampleModel;
      const baseElements = byId(baseModel.elements ?? []);
      const updatedElements = byId(updated.elements ?? []);
      expect([...updatedElements.keys()].sort()).toEqual([...baseElements.keys(), 'export'].sort());
      for (const [id, element] of baseElements) {
        if (id === 'importer') continue; // its evidence is re-pinned to the branch
        expect(updatedElements.get(id)).toEqual(element);
      }
      expect(updated.interfaces).toEqual(baseModel.interfaces);
      const baseRelations = byId(baseModel.relations ?? []);
      const updatedRelations = byId(updated.relations ?? []);
      expect([...updatedRelations.keys()].sort()).toEqual([...baseRelations.keys(), 'importer-exports'].sort());
      for (const [id, relation] of baseRelations) {
        if (id === 'clerk-scans' || id === 'importer-stores' || id === 'importer-notifies') continue; // re-pinned
        expect(updatedRelations.get(id)).toEqual(relation);
      }

      // The new dependency is named for what the importer uses.
      const exportsRelation = updatedRelations.get('importer-exports')!;
      expect(exportsRelation.from).toBe('importer');
      expect(exportsRelation.to).toBe('export');
      expect(exportsRelation.name).toBe('writes each receipt to the export file');
    });
  });

  test('a branch that changes only a function body: identical ids and relations, re-pinned evidence, no stale items', () => {
    withRepo((repo) => {
      const { pinned, base, substituteBase } = baseExample(repo);

      // The branch: the body of one function in an already-modelled file.
      const store = readFileSync(join(repo.path, 'src', 'store.ts'), 'utf8');
      writeFileSync(join(repo.path, 'src', 'store.ts'), store.replace('return receipts.get(id);', 'return receipts.get(id.trim());'));
      const head = repo.commit('tolerate whitespace around a scanned id');

      // The expected update: only the archive's evidence re-pinned —
      // the same lines, the branch's commit and blob.
      const baseModelText = substituteBase(readFileSync(join(EXAMPLE_DIR, 'madarch', 'model.yaml'), 'utf8'));
      const updatedModelText = baseModelText.replace(
        `commit: ${pinned}\n        blob: ${repo.blob('src/store.ts', pinned)}`,
        `commit: ${head}\n        blob: ${repo.blob('src/store.ts', head)}`,
      );
      expect(updatedModelText).not.toBe(baseModelText);
      writeFileSync(join(repo.path, 'madarch', 'model.yaml'), updatedModelText);

      // The report: the update section says in one line that nothing
      // architectural changed, and the check still reads the tables.
      const review = readFileSync(join(repo.path, 'madarch', 'review.md'), 'utf8');
      writeFileSync(
        join(repo.path, 'madarch', 'review.md'),
        `${review}\n## Update ${base.slice(0, 7)}..${head.slice(0, 7)}\n\n` +
          'No architectural change: the branch touches only the body of `findReceipt` in `src/store.ts`; the `archive` element\'s evidence is re-pinned.\n',
      );

      const report = checkModel(repo.path, {});
      expect(report.outcome).toBe('passed');
      expect(report.errors).toEqual([]);
      expect(report.stale).toEqual([]);

      const baseModel = parseYaml(baseModelText) as ExampleModel;
      const updated = parseYaml(updatedModelText) as ExampleModel;
      expect(updated.elements?.map((element) => element.id)).toEqual(baseModel.elements?.map((element) => element.id));
      expect(updated.relations).toEqual(baseModel.relations);
      const updatedElements = byId(updated.elements ?? []);
      for (const element of baseModel.elements ?? []) {
        const updatedElement = updatedElements.get(element.id)!;
        if (element.id !== 'archive') {
          expect(updatedElement).toEqual(element);
          continue;
        }
        const { evidence, ...fields } = element;
        const { evidence: updatedEvidence, ...updatedFields } = updatedElement;
        expect(updatedFields).toEqual(fields);
        expect(updatedEvidence).toEqual([{ ...evidence![0]!, commit: head, blob: repo.blob('src/store.ts', head) }]);
      }
    });
  });
});
