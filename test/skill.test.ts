import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkModel } from '../src/check/model-check.js';
import { withRepo } from './model-check-repo.js';

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
