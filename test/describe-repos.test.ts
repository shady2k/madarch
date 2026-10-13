/**
 * The describing step, outcome 4 of the standalone charter (decision 0021
 * (d); the change engine-skills-install-contract): the skill set's
 * installed release carries the step — the engine's checkout ships no
 * skills — and what a described repository leaves is read from the files
 * the step writes, never from the set's own texts. The skeleton's
 * byte-for-byte pin is `test/product-draft.test.ts` (decision 0021: the
 * constitution is what madarch's own creation writes, held byte for byte
 * against the contract example product's
 * `examples/contract/set-made-product/AGENTS.md`); these tests prove the
 * checkout ships no skill folder, and that a product whose agent laid the
 * describing section reads as one document with the constitution.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createDraft, CONSTITUTION as PINNED_AGENTS } from '../src/product/draft.js';
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

/** The repository root of the checkout under test. */
const repoRoot = join(import.meta.dir, '..');

/**
 * The section the installed set lays below the maintained markers: the
 * project's own sample, held beside the tests so the layout claim has a
 * text to prove (never a copy of the set's skill content — the checkout
 * ships none to copy).
 */
const SECTION = [
  "When a code repository is connected to the product — the engine's `repo add",
  'or any way the manifest gained the entry — describe it before working on it:',
  "ask the agent to describe the repository, and it follows the set's",
  "describing skill — the repository's intended model into the",
  "repository's own model folder with its evidence, the architecture page under",
  '`docs/repositories/<name>/`, the capabilities found in the code as',
  'requirements and use cases marked derived from code, and the decisions found',
  'in the code or its ADRs, each linked to the model elements it shapes. A',
  'repository with uncommitted changes is described only after they are',
  'committed. Every page is written under `docs/`, so the wiki shows it as it',
  'is saved.',
  '',
].join('\n');

/** The engineer's guide, updated by this change to name the set's release. */
const guidePath = join(repoRoot, 'docs', 'guides', 'start-a-product.md');
const guide = readFileSync(guidePath, 'utf8');

const maintainedClose = '<!-- /product:maintained -->';

/** The product the laid section makes: the pinned constitution, the section below it. */
function productAgents(): string {
  return PINNED_AGENTS + SECTION;
}

describe('what the checkout carries for the step', () => {
  test('the checkout ships no skills folder — the step lives in the installed set', () => {
    expect(readdirSync(repoRoot).includes('skills')).toBe(false);
  });

  test('the guide names the set release the install contract carries, not a folder of this checkout', () => {
    const section = guide.indexOf('## Describe each repository you connected');
    expect(section).toBeGreaterThan(-1);
    const step = guide.slice(section);
    expect(step).toContain('shady2k-skills 0.106.0 or later');
    expect(step).toContain('not with the');
    // No copy step, no section file, no path into the madarch checkout's skills folder:
    // the guide never sends anyone into the engine checkout for a skill.
    expect(/^    (cp|cat) /.test(step)).toBe(false);
    expect(step.includes('-section.md')).toBe(false);
    expect(step.includes('/skills/')).toBe(false);
  });
});

describe('what a real draft made by madarch new holds', () => {
  test('a fresh draft carries nothing laid — the honest absence', () => {
    const draft = draftIn(tempFolder('madarch-describe-'));
    if (draft.outcome !== 'created') throw new Error(`the draft was not created: ${JSON.stringify(draft)}`);
    expect(readFileSync(join(draft.folder, 'AGENTS.md'), 'utf8')).toBe(PINNED_AGENTS);
    expect(readdirSync(join(draft.folder, 'skills'))).toEqual(['.gitkeep']);
  });

  test('the laid section reads below the maintained markers, one document with the constitution', () => {
    const draft = draftIn(tempFolder('madarch-describe-'));
    if (draft.outcome !== 'created') throw new Error(`the draft was not created: ${JSON.stringify(draft)}`);
    // What an installation lays, run for real: the section appended below the constitution.
    appendFileSync(join(draft.folder, 'AGENTS.md'), SECTION);
    const agents = readFileSync(join(draft.folder, 'AGENTS.md'), 'utf8');
    expect(agents).toBe(productAgents());
    const close = agents.indexOf(maintainedClose);
    expect(close).toBeGreaterThan(-1);
    expect(agents.slice(0, close + maintainedClose.length)).toBe(PINNED_AGENTS.slice(0, PINNED_AGENTS.indexOf(maintainedClose) + maintainedClose.length));
    expect(readdirSync(join(draft.folder, 'skills'))).toEqual(['.gitkeep']);
  });

  test('a simulated product holding the pinned constitution plus the section reads as one document', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madarch-describe-'));
    try {
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
  test('the guide names the step after repo add, its artifacts and the wiki\'s live display', () => {
    const section = guide.indexOf('## Describe each repository you connected');
    expect(section).toBeGreaterThan(-1);
    const step = guide.slice(section);
    expect(step).toContain('repo add');
    expect(step).toContain('describing skill');
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
    expect(commands.length).toBeGreaterThan(0);
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
