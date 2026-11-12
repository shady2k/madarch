#!/usr/bin/env bun
/**
 * UI-kit boundary for non-test wiki/app/src TSX outside components/ui.
 *
 * bun run check:ui                         compare findings with the frozen debt
 * bun scripts/check-ui-architecture.ts --prune
 *                                         remove resolved debt; refuse new debt
 * bun scripts/check-ui-architecture.ts --base-guard [--base <revision>]
 *                                         refuse baseline additions since base
 *
 * Root and wiki `bun run check` run the comparison. CI also runs the guard via
 * `check:architecture-base`. The first adoption may introduce the list when the
 * base has none; later changes only remove entries. New violations must be fixed,
 * never accepted by regenerating the list. Entries use normalized node hashes
 * plus occurrence numbers (component names for local components), not line
 * numbers, so unrelated line shifts do not force baseline changes.
 *
 * Tests: bun test test/ui-architecture.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { compareUiDebt, debtKey, readUiBaseline, renderUiBaseline, scanUi, UI_BASELINE } from './check/architecture/ui.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const listPath = resolve(root, UI_BASELINE);
try {
  const args = process.argv.slice(2);
  const valid = args.length === 0 || (args.length === 1 && ['--prune', '--base-guard'].includes(args[0]!)) ||
    (args.length === 3 && args[0] === '--base-guard' && args[1] === '--base' && !args[2]!.startsWith('-'));
  if (!valid) throw new Error('usage: check-ui-architecture.ts [--prune | --base-guard [--base <revision>]]');
  const listed = readUiBaseline(readFileSync(listPath, 'utf8'));
  if (args.includes('--base-guard')) {
    const index = args.indexOf('--base');
    const base = index < 0 ? execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: root, encoding: 'utf8' }).trim() : args[index + 1];
    if (!base) throw new Error('--base requires a revision');
    const paths = execFileSync('git', ['ls-tree', '--name-only', base, '--', UI_BASELINE], { cwd: root, encoding: 'utf8' }).trim();
    // The adoption commit introduces the frozen list; later commits may only shrink it.
    if (!paths) {
      console.log(`UI architecture: initial baseline adoption (no list at ${base})`);
      process.exit(0);
    }
    const previous = readUiBaseline(execFileSync('git', ['show', `${base}:${UI_BASELINE}`], { cwd: root, encoding: 'utf8' }));
    const comparison = compareUiDebt(listed, previous);
    for (const entry of comparison.added) console.error(`${resolve(root, entry.file)}:1: ${entry.rule}: baseline gained ${entry.subject} since ${base}`);
    process.exitCode = comparison.added.length > 0 ? 1 : 0;
  } else {
    const found = scanUi(root);
    const comparison = compareUiDebt(found, listed);
    const locations = new Map(found.map(entry => [debtKey(entry), entry.line]));
    for (const entry of comparison.added) console.error(`${resolve(root, entry.file)}:${locations.get(debtKey(entry))}: ${entry.rule}: new UI debt ${entry.subject}; compose components/ui instead`);
    for (const entry of comparison.duplicated) console.error(`${listPath}:1: duplicate ${debtKey(entry)}`);
    if (args.includes('--prune') && comparison.added.length === 0 && comparison.duplicated.length === 0) {
      writeFileSync(listPath, renderUiBaseline(found));
      console.log(`UI architecture: removed ${comparison.stale.length} resolved entries; ${found.length} remain`);
    } else {
      for (const entry of comparison.stale) console.error(`${listPath}:1: stale ${debtKey(entry)}; remove resolved debt with --prune`);
      process.exitCode = comparison.added.length + comparison.stale.length + comparison.duplicated.length > 0 ? 1 : 0;
      console.log(`UI architecture: ${found.length} violations found; ${listed.length} listed`);
    }
  }
} catch (error) {
  console.error(`${listPath}:1: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
