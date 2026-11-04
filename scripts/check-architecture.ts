#!/usr/bin/env bun
/**
 * The architecture check as a command (decision 0033, item 4): `bun run check` runs it,
 * and so does CI.
 *
 *   bun scripts/check-architecture.ts                      the rules against the list
 *   bun scripts/check-architecture.ts --update             write the list of what the rules find now
 *   bun scripts/check-architecture.ts --rules one-fill-entry[,graph-single-writer]   some rules only
 *   bun scripts/check-architecture.ts --base-guard [--base <rev>]   the list only shrinks (CI)
 *
 * Every failure names the rule, the file's full path and the line, one problem per
 * line, and the command exits 1. A run that finds exactly what the list holds exits 0.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  architectureCheck,
  architectureCheckPasses,
  architectureProblemLines,
  countsByRule,
  renderViolationListOf,
  VIOLATION_LIST,
} from '../src/check/architecture/check.js';
import { baseGuard, baseGuardPasses, baseGuardProblemLines } from '../src/check/architecture/base-guard.js';
import { ARCHITECTURE_RULES, type ArchitectureRule } from '../src/check/architecture/violation.js';

interface Options {
  readonly update: boolean;
  readonly baseGuardOnly: boolean;
  readonly base: string | undefined;
  readonly rules: readonly ArchitectureRule[];
  readonly help: boolean;
}

const USAGE = [
  'the architecture check of decision 0033, item 4',
  '',
  '  bun scripts/check-architecture.ts                     the rules against .architecture/violations.json',
  '  bun scripts/check-architecture.ts --update            write what the rules find now into the list',
  '  bun scripts/check-architecture.ts --rules <names>     run some of the rules, comma separated',
  '  bun scripts/check-architecture.ts --base-guard        fail when the list gained an entry since the merge base',
  '  bun scripts/check-architecture.ts --base <rev>        the commit the guard compares against',
  '  bun scripts/check-architecture.ts --help              print this help',
  '',
  `the rules: ${ARCHITECTURE_RULES.join(', ')}`,
].join('\n');

function fail(message: string): never {
  const script = resolve(process.argv[1] ?? 'scripts/check-architecture.ts');
  console.error(`${script}:1: ${message}`);
  process.exit(2);
}

function parse(argv: readonly string[]): Options {
  let update = false;
  let baseGuardOnly = false;
  let base: string | undefined;
  let rules: readonly ArchitectureRule[] = ARCHITECTURE_RULES;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--update') update = true;
    else if (argument === '--base-guard') baseGuardOnly = true;
    else if (argument === '--help' || argument === '-h') help = true;
    else if (argument === '--base') {
      const value = argv[index + 1];
      if (value === undefined) fail('--base names the commit the guard compares against, and none was given');
      base = value;
      index += 1;
    } else if (argument === '--rules') {
      const value = argv[index + 1];
      if (value === undefined) fail(`--rules names the rules to run (${ARCHITECTURE_RULES.join(', ')}), and none was given`);
      rules = value.split(',').map((name) => {
        const trimmed = name.trim() as ArchitectureRule;
        if (!ARCHITECTURE_RULES.includes(trimmed)) fail(`--rules names ${JSON.stringify(name)}, which is not one of ${ARCHITECTURE_RULES.join(', ')}`);
        return trimmed;
      });
      index += 1;
    } else fail(`the argument ${JSON.stringify(argument)} is not one this command knows; --help lists them`);
  }
  return { update, baseGuardOnly, base, rules, help };
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parse(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.baseGuardOnly) {
    const report = baseGuard(options.base === undefined ? {} : { base: options.base });
    if (baseGuardPasses(report)) {
      console.log(`architecture: the list gained no entry since ${report.base}${report.baseHasList ? '' : ' (which holds no list)'}`);
      return 0;
    }
    for (const line of baseGuardProblemLines(report)) console.log(line);
    return 1;
  }
  const report = await architectureCheck({ rules: options.rules });
  if (options.update) {
    const before = new Set(report.listed.map((entry) => `${entry.rule}\u0000${entry.file}\u0000${entry.symbol ?? ''}`));
    writeFileSync(report.listPath, renderViolationListOf(report));
    const after = new Set(report.found.map((entry) => `${entry.rule}\u0000${entry.file}\u0000${entry.symbol ?? ''}`));
    const joined = [...after].filter((entry) => !before.has(entry)).length;
    const left = [...before].filter((entry) => !after.has(entry)).length;
    console.log(`${VIOLATION_LIST}: ${after.size} violations written (${joined} joined, ${left} left)`);
    return 0;
  }
  const counts = countsByRule(report.found);
  const summary = ARCHITECTURE_RULES.filter((rule) => options.rules.includes(rule))
    .map((rule) => `${rule} ${counts.get(rule) ?? 0}`)
    .join(', ');
  const problems = architectureProblemLines(report);
  for (const problem of problems) console.log(problem);
  console.log(
    `architecture: ${report.found.length} violations found (${summary}); ${report.listed.length} listed in ${VIOLATION_LIST}${problems.length === 0 ? '' : `, ${problems.length} problem${problems.length === 1 ? '' : 's'}`}`,
  );
  return architectureCheckPasses(report) ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
