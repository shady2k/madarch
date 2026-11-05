#!/usr/bin/env bun
/**
 * `bun run check:workflows` (decision 0033, items 1 and 2): the mechanical check of
 * the workflows the starter set holds, run over the starter set exactly as
 * `madarch new` writes it.
 *
 *   bun run check:workflows                    the starter set, written into a temporary product and checked
 *   bun run check:workflows --folder <folder>  the workflows of a product folder that already exists
 *
 * The command reads `madarch/workflows.yaml` through the workflow reader
 * (`src/knowledge/workflows.ts`), which derives each implemented workflow's stage
 * graph the way a run does, and reports its findings only: the product's documents
 * and their expectations are the product's matter, not the workflows'. A finding
 * is printed as `<full path>:<line>: <the words>`, naming the workflow and the
 * stage it is about, and the command exits 1; a run that finds nothing names the
 * counts and exits 0. Arguments it does not understand exit 2.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { readWorkflows, WORKFLOWS_FILE, type WorkflowStatus } from '../src/knowledge/workflows.js';

const USAGE = 'usage: bun run check:workflows [--folder <product folder>]';

function fail(message: string): never {
  console.error(`${resolve(process.argv[1] ?? 'scripts/check-workflows.ts')}:1: ${message}`);
  process.exit(2);
}

/** The folder named after `--folder`, or a temporary product holding the starter set. */
function folderOf(argv: readonly string[]): { folder: string; temporary: boolean } {
  let named: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--folder') {
      named = argv[index + 1];
      if (named === undefined || named.startsWith('--')) fail('--folder names the product folder to check, and none was given');
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else fail(`the argument ${JSON.stringify(argument)} is not one this command knows; --help lists them`);
  }
  if (named !== undefined) return { folder: resolve(named), temporary: false };
  const folder = mkdtempSync(join(tmpdir(), 'madarch-workflows-'));
  seedStarterSet(folder);
  return { folder, temporary: true };
}

function main(): void {
  const { folder, temporary } = folderOf(process.argv.slice(2));
  try {
    const read = readWorkflows(folder);
    if (!read.present) {
      console.error(`${join(folder, WORKFLOWS_FILE)}:1: the product holds no workflows manifest, and the starter set writes one`);
      process.exit(1);
    }
    let failed = false;
    for (const finding of read.findings) {
      console.error(`${finding.file}:${finding.line}: ${finding.message}`);
      failed = true;
    }
    const workflows = [...read.workflows.values()];
    const count = (status: WorkflowStatus): number => workflows.filter((workflow) => workflow.status === status).length;
    console.log(`workflows: ${workflows.length} workflows (${count('implemented')} implemented, ${count('planned')} planned); ${read.file}`);
    if (failed) process.exit(1);
  } finally {
    if (temporary) rmSync(folder, { recursive: true, force: true });
  }
}

main();
