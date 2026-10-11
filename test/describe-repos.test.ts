/**
 * The describing step (madarch-iuc.17, docs/changes/wiki-describe-repos):
 * the product's own instructions — the `AGENTS.md` section naming the step
 * and the `skills/describe-repository/` folder beside it — and the engineer's
 * guide's describing section, read as the capability pins them. The
 * skeleton's byte-for-byte pin is `product-pin.test.ts` and stands: this
 * file reads what the product's own writing carries, never the program's.
 * The step itself lives outside the pinned program (decision 0019), so the
 * texts are held beside the pinned skeleton as the product's own writing,
 * and the tests prove what a product made by the pinned program plus this
 * repository's two additions holds.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/** The repository file this change owns, read from the checkout itself. */
const repoRoot = join(import.meta.dir, '..');

/** The pinned skeleton's constitution: the part this change must not move. */
const PINNED_AGENTS = readFileSync(join(repoRoot, 'vendor', 'shady2k-skills', '0.94.0', 'fixtures', 'product', 'good', 'AGENTS.md'), 'utf8');

/** The describing section this change writes below the pinned constitution. */
const DESCRIBE_SECTION = readFileSync(join(repoRoot, 'docs', 'changes', 'wiki-describe-repos', 'agents-describing-section.md'), 'utf8');

/** The product's own skill folder this change writes into a new product's `skills/`. */
const SKILL = readFileSync(join(repoRoot, 'skills', 'describe-repository', 'SKILL.md'), 'utf8');

/** The engineer's guide, extended by this change with the describing step. */
const guidePath = join(repoRoot, 'docs', 'guides', 'start-a-product.md');
const guide = readFileSync(guidePath, 'utf8');

const maintainedClose = '<!-- /product:maintained -->';

/** The constitution a new product holds: the pinned program's bytes, the step below them. */
function productAgents(): string {
  return PINNED_AGENTS + DESCRIBE_SECTION;
}

describe("the skeleton's describing step", () => {
  test('AGENTS.md carries the describing section below the maintained markers', () => {
    const agents = productAgents();
    const close = agents.indexOf(maintainedClose);
    expect(close).toBeGreaterThan(-1);
    const own = agents.slice(close);
    expect(own).toContain('madarch repo add');
    expect(own).toContain('skills/describe-repository/');
    expect(own).toContain('derived from code');
    expect(own).toContain('docs/repositories/');
    expect(own).toContain('uncommitted changes');
    // The step names the model landing in the repository's own folder and the pages under docs/.
    expect(own).toContain('madarch/');
    // One maintained marker pair only: the section is below the maintained part, not inside it.
    expect(agents.split(maintainedClose)).toHaveLength(2);
  });

  test('the maintained part above the section is byte for byte the pinned program\'s constitution', () => {
    const agents = productAgents();
    const end = PINNED_AGENTS.indexOf(maintainedClose) + maintainedClose.length;
    expect(agents.slice(0, end + 1)).toBe(PINNED_AGENTS.slice(0, end + 1));
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
    // The citations the skill demands name a file and a line: the worked
    // Evidence line shows the shape, and the traceability sentence shows the
    // per-statement citation.
    expect(SKILL).toContain('Evidence: notes.py L6-11');
    expect(SKILL).toContain('(notes.py:8-9)');
  });

  test('a scratch product folder holding the pinned constitution plus the section reads as one document', () => {
    // The section is joined to the pinned bytes the way a product's AGENTS.md holds both.
    const dir = mkdtempSync(join(tmpdir(), 'madarch-describe-'));
    try {
      const { writeFileSync } = require('node:fs');
      writeFileSync(join(dir, 'AGENTS.md'), productAgents());
      const read = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
      expect(read.startsWith(PINNED_AGENTS.slice(0, PINNED_AGENTS.indexOf('## Documents')))).toBe(true);
      expect(read).toContain(maintainedClose);
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
