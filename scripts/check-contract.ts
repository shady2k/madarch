#!/usr/bin/env bun
/**
 * `bun run contract:check` (decision 0021, outcome 1 of the standalone
 * charter): checks the product kinds registry's contract the way
 * `bun run views:check` checks the views — the examples are the folders and
 * cases the repository holds beside the schema, and CI runs this command
 * after the tests. Exit 0 when every example reads the way its case says,
 * 1 listing every mismatch with its file and line, 2 for arguments it does
 * not understand. Never throws: a broken input is a refusal named like the
 * others.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseContractText } from '../src/product/contract.js';

/** The case file the examples answer, like the set's own fixture cases. */
interface ContractCase {
  name: string;
  /** The registry file's whole text; `null` when the case is a file the reader finds empty. */
  text: string | null;
  /** The line the refusal stands on; absent for an example that reads. */
  line?: number;
  /** The field's path from the registry's top the refusal names; absent when the case pins none. */
  path?: string;
  /** The words the refusal carries; absent for an example that reads. */
  message?: string;
}

const USAGE = 'usage: bun run contract:check [--cases <file>] [--src <file>]';
const DEFAULT_CASES = fileURLToPath(new URL('../examples/contract/registry-cases.json', import.meta.url));

/** One check: whether one case agrees with the reading, and the words either way. */
interface CaseVerdict {
  case: string;
  problems: string[];
}

const verdicts: CaseVerdict[] = [];

/** Runs one contract case and records the mismatch's file, line and words. */
function checkCase(one: ContractCase): void {
  if (one.text === null || one.text === undefined) {
    verdicts.push({ case: one.name, problems: [`the case ${one.name} carries no text: every example holds the registry file's whole text`] });
    return;
  }
  const read = parseContractText('docs/kinds.yaml', one.text);
  if (one.message === undefined) {
    if (!read.ok) {
      const first = read.errors[0];
      verdicts.push({ case: one.name, problems: [`expected the registry to read, got refused at ${first.file}:${first.line}: ${first.message}`] });
    } else {
      verdicts.push({ case: one.name, problems: [] });
    }
    return;
  }
  if (read.ok) {
    verdicts.push({ case: one.name, problems: [`expected a refusal naming ${one.message}, got read as ok`] });
    return;
  }
  const named = read.errors.some((error) => error.line === (one.line ?? 1) && error.message.includes(one.message!) && (one.path === undefined || error.path === one.path));
  if (!named) {
    const held = read.errors.map((error) => `${error.path || '-'}:${error.line}: ${error.message}`).join('; ');
    verdicts.push({ case: one.name, problems: [`expected a refusal on line ${one.line ?? 1} naming ${JSON.stringify(one.message)}${one.path === undefined ? '' : ` at ${one.path}`}, got ${held}`] });
    return;
  }
  verdicts.push({ case: one.name, problems: [] });
}

function run(casesPath: string, sourcePath: string | undefined): number {
  if (sourcePath !== undefined) {
    const text = readFileSync(sourcePath, 'utf8');
    const read = parseContractText(sourcePath, text);
    if (read.ok) {
      console.log(`${sourcePath}: reads, ${read.kinds.length} kinds, ${read.stages.length} stages`);
      return 0;
    }
    for (const error of read.errors) console.error(`error: ${error.file}:${error.line}: ${error.message}`);
    return 1;
  }
  const file = JSON.parse(readFileSync(casesPath, 'utf8')) as { cases: ContractCase[] };
  for (const one of file.cases) checkCase(one);
  let failed = 0;
  for (const verdict of verdicts) {
    if (verdict.problems.length === 0) continue;
    failed++;
    for (const problem of verdict.problems) console.error(`error: case ${verdict.case}: ${problem}`);
  }
  console.log(`contract: ${file.cases.length} cases, ${failed} misread`);
  return failed > 0 ? 1 : 0;
}

let casesPath = DEFAULT_CASES;
let sourcePath: string | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i];
  const value = args[i + 1];
  if (flag === '--cases') {
    casesPath = value!;
    continue;
  }
  if (flag === '--src') {
    sourcePath = value;
    continue;
  }
  console.error(`error: ${USAGE}`);
  process.exit(2);
}
process.exitCode = run(casesPath, sourcePath);
