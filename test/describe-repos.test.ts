/**
 * The describing step (madarch-iuc.17, docs/changes/wiki-describe-repos):
 * madarch carries the step in its own checkout — the
 * `skills/describe-repository/` folder, the skill's SKILL.md beside the
 * AGENTS-section.md text — and the engineer's guide names the copy that lays
 * them into a product. The skeleton's byte-for-byte pin is
 * `test/product-draft.test.ts` (decision 0021: the constitution is what
 * madarch's own creation writes, held byte for byte against the contract
 * example product's `examples/contract/set-made-product/AGENTS.md`); these
 * tests prove the checkout's own texts and what the copy lays into a real
 * draft.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createDraft } from '../src/product/draft.js';
import { gitEnv } from './git-env.js';
import { GIT_ENV } from './model-check-repo.js';
import { refuseNonScratchHome, noStrayDrafts, ISOLATED_HOME } from './scratch-home.js';

process.env.MADARCH_HOME = ISOLATED_HOME;

const made: string[] = [];

function tempFolder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const removeMadeFolders = (): void => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  const strays = noStrayDrafts();
  if (strays.newEntries.length) throw new Error(`the real products home gained entries while the tests ran (named, left in place): ${strays.newEntries.join(', ')}`);
};

afterEach(removeMadeFolders);

/** The ninth of October 2026, the capability's example day, as a local date. */
const EXAMPLE_DAY = new Date(2026, 9, 9);

/** Creates a REAL draft on the capability's example day, git sealed to a fixed identity. */
function draftIn(home: string) {
  return createDraft({ home: refuseNonScratchHome(home, 'describe-repos'), today: EXAMPLE_DAY, gitEnv: gitEnv(GIT_ENV) });
}

/** The repository files this change owns, read from the checkout itself. */
const repoRoot = join(import.meta.dir, '..');

/** The constitution madarch's own creation writes: the part the commands must not move. */
import { CONSTITUTION as PINNED_AGENTS } from '../src/product/draft.js';

/** The describing section, carried beside the skill it names. */
const SECTION = readFileSync(join(repoRoot, 'skills', 'describe-repository', 'AGENTS-section.md'), 'utf8');

/** The skill's own instructions. */
const SKILL = readFileSync(join(repoRoot, 'skills', 'describe-repository', 'SKILL.md'), 'utf8');

/** The engineer's guide, extended by this change with the describing step. */
const guidePath = join(repoRoot, 'docs', 'guides', 'start-a-product.md');
const guide = readFileSync(guidePath, 'utf8');

const maintainedClose = '<!-- /product:maintained -->';

/** The product the guide's copy makes: the pinned constitution, the section below it. */
function productAgents(): string {
  return PINNED_AGENTS + SECTION;
}

describe('what madarch carries for the step', () => {
  test('the checkout holds the skill and the section in one folder', () => {
    expect(readdirSync(join(repoRoot, 'skills', 'describe-repository')).sort()).toEqual(['AGENTS-section.md', 'SKILL.md']);
  });

  test('the skill names the Agent Skills identity and the four artifacts', () => {
    expect(SKILL).toContain('name: describe-repository');
    expect(SKILL).toMatch(/^---\n/);
    expect(SKILL).toContain('derived from code');
    expect(SKILL).toContain('Source: code');
    expect(SKILL).toContain('Evidence:');
    expect(SKILL).toContain('architecture.md');
    expect(SKILL).toContain('MADR');
    expect(SKILL).toContain('review.md');
  });

  test("the skill's procedure runs the model check from a madarch checkout and refuses an uncommitted checkout", () => {
    expect(SKILL).toContain('bun scripts/check-model.ts');
    expect(SKILL).toContain('status --porcelain');
    expect(SKILL).toContain('$REPO/madarch/');
    expect(SKILL).toContain('docs/repositories/');
    // The model-folder link climbs exactly three levels from
    // docs/repositories/<name>/ to the product's root, then into repos/.
    expect(SKILL).toContain('../../../repos/<name>/madarch/');
    expect(SKILL).not.toContain('../../../../repos/');
    // The citations the skill demands name a file and a line: the worked
    // Evidence line shows the shape, and the traceability sentence shows the
    // per-statement citation.
    expect(SKILL).toContain('Evidence: notes.py L6-11');
    expect(SKILL).toContain('(notes.py:8-9)');
  });

  test('the section names the step: the skill, the four artifacts, the rules, the live wiki', () => {
    expect(SECTION).toContain('madarch repo add');
    expect(SECTION).toContain('skills/describe-repository/');
    expect(SECTION).toContain('derived from code');
    expect(SECTION).toContain('docs/repositories/');
    expect(SECTION).toContain('uncommitted changes');
    expect(SECTION).toContain('madarch/');
  });
});

describe('what a real draft made by madarch new holds', () => {
  test('a fresh draft carries neither the skill folder nor the section — the honest absence', () => {
    const draft = draftIn(tempFolder('madarch-describe-'));
    if (draft.outcome !== 'created') throw new Error(`the draft was not created: ${JSON.stringify(draft)}`);
    expect(readFileSync(join(draft.folder, 'AGENTS.md'), 'utf8')).toBe(PINNED_AGENTS);
    expect(readdirSync(join(draft.folder, 'skills'))).toEqual(['.gitkeep']);
  });

  test('the copy the guide names lays the step: the skill beside .gitkeep, the section below the markers', () => {
    const draft = draftIn(tempFolder('madarch-describe-'));
    if (draft.outcome !== 'created') throw new Error(`the draft was not created: ${JSON.stringify(draft)}`);
    // The guide's two commands, run for real.
    cpSync(join(repoRoot, 'skills', 'describe-repository'), join(draft.folder, 'skills', 'describe-repository'), { recursive: true });
    appendFileSync(join(draft.folder, 'AGENTS.md'), SECTION);
    const agents = readFileSync(join(draft.folder, 'AGENTS.md'), 'utf8');
    expect(agents).toBe(productAgents());
    const close = agents.indexOf(maintainedClose);
    expect(close).toBeGreaterThan(-1);
    expect(agents.slice(0, close + maintainedClose.length)).toBe(PINNED_AGENTS.slice(0, PINNED_AGENTS.indexOf(maintainedClose) + maintainedClose.length));
    expect(readdirSync(join(draft.folder, 'skills')).sort()).toEqual(['.gitkeep', 'describe-repository']);
    expect(readdirSync(join(draft.folder, 'skills', 'describe-repository')).sort()).toEqual(['AGENTS-section.md', 'SKILL.md']);
  });

  test('a simulated product holding the pinned constitution plus the section reads as one document', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madarch-describe-'));
    try {
      const { writeFileSync } = require('node:fs');
      writeFileSync(join(dir, 'AGENTS.md'), productAgents());
      const read = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
      expect(read.startsWith(PINNED_AGENTS.slice(0, PINNED_AGENTS.indexOf('## Documents')))).toBe(true);
      expect(read).toContain(maintainedClose);
      // One maintained marker pair only: the section is below the maintained part, not inside it.
      expect(read.split(maintainedClose)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the engineer's guide describing step", () => {
  test('the guide names the copy, the step after repo add, its artifacts and the wiki\'s live display', () => {
    const section = guide.indexOf('## Describe each repository you connected');
    expect(section).toBeGreaterThan(-1);
    const step = guide.slice(section);
    // The copy: the skill folder into the product's skills/, the section appended to AGENTS.md.
    expect(step).toContain('cp -r skills/describe-repository');
    expect(step).toContain('AGENTS-section.md >>');
    expect(step).toContain('repo add');
    expect(step).toContain('describe-repository');
    expect(step).toContain('within two seconds');
    expect(step).toContain('uncommitted');
    expect(step).toContain('derived from code');
    // The guide's own commands stay as they were: the where-resolution section follows.
    expect(step.indexOf('## How the commands find the product')).toBeGreaterThan(-1);
  });

  test('every command line the step adds is copy-pasteable plain text with no placeholder', () => {
    const start = guide.indexOf('## Describe each repository you connected');
    const end = guide.indexOf('## How the commands find the product');
    if (start === -1 || end === -1) throw new Error('the guide lost its describing section or the section that follows it');
    const step = guide.slice(start, end);
    const commands = step.split('\n').filter((line) => line.startsWith('    ') && line.trim() !== '');
    expect(commands.length).toBeGreaterThan(1);
    for (const line of commands) {
      expect(line.includes('<')).toBe(false);
    }
  });

  test('the guide keeps every section the onboarding run wrote, in order', () => {
    for (const heading of ['## Install madarch', '## Create the draft', '## Name the product', '## Add the repositories you already have',
      '## Commit, add your remote, push', '## A colleague joins', '## Open the wiki', '## Start the work with your agent',
      '## Describe each repository you connected', '## How the commands find the product']) {
      expect(guide).toContain(heading);
    }
    const positions: number[] = [];
    for (const heading of ['## Start the work with your agent', '## Describe each repository you connected', '## How the commands find the product']) {
      const at = guide.indexOf(heading);
      if (at === -1) throw new Error(`the guide lost ${heading}`);
      positions.push(at);
    }
    const workAt = positions[0] ?? -1;
    const describeAt = positions[1] ?? -1;
    const whereAt = positions[2] ?? -1;
    expect(workAt).toBeGreaterThan(-1);
    expect(workAt).toBeLessThan(describeAt);
    expect(describeAt).toBeLessThan(whereAt);
  });
});
