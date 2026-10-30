#!/usr/bin/env bun
/**
 * Run the answer-key check against a product whose wiki has already been filled.
 *
 *   bun scripts/answer-key-check.ts --product <folder> --store <folder> [--out <folder>]
 *
 * The threshold is printed and written, but this command exits 0 for a completed
 * check even when the threshold is not met: the threshold is not the gate.
 */
import { resolve } from 'node:path';
import { defaultAnswerKeyFile, defaultQuestionKeyFile, defaultStoreRoot, reportText, runAnswerKeyCheck } from '../src/knowledge/answer-key-check.js';

interface Options {
  product: string;
  store: string;
  out: string;
  key: string;
  questions: string;
  help: boolean;
}

function fail(message: string): never {
  const script = resolve(process.argv[1] ?? 'scripts/answer-key-check.ts');
  throw new Error(`${script}:1: ${message}; full path ${script}`);
}

function usage(): string {
  return [
    'answer-key check: build evidence packs for a filled product wiki',
    '',
    '  --product <folder>     product folder holding workspace.yaml (required)',
    '  --store <folder>       knowledge store (default: ~/.madarch/knowledge)',
    '  --out <folder>         output folder (default: out/answer-key)',
    '  --key <file>           main answer key (default: examples/training-repository/answer-key.json)',
    '  --questions <file>     explicit expected questions (default: examples/training-repository/agent-stage/answer-key.json)',
    '  --help                 print this help',
  ].join('\n');
}

function parse(argv: readonly string[]): Options {
  const root = resolve(import.meta.dir, '..');
  const options: Options = {
    product: '',
    store: defaultStoreRoot(),
    out: resolve('out/answer-key'),
    key: defaultAnswerKeyFile(root),
    questions: defaultQuestionKeyFile(root),
    help: false,
  };
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (flag === '--product') options.product = value ?? '';
    else if (flag === '--store') options.store = value ?? '';
    else if (flag === '--out') options.out = value ?? '';
    else if (flag === '--key') options.key = value ?? '';
    else if (flag === '--questions') options.questions = value ?? '';
    else fail(`unknown argument ${flag ?? ''}`);
    if (value === undefined || value === '') fail(`missing value after ${flag}`);
    index += 2;
  }
  if (options.help) return options;
  if (options.product === '') fail('--product is required');
  return options;
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const { check, written } = await runAnswerKeyCheck({
    productFolder: resolve(options.product),
    storeRoot: resolve(options.store),
    keyFile: resolve(options.key),
    questionKeyFile: resolve(options.questions),
    outFolder: resolve(options.out),
  });
  console.log(reportText(check));
  console.log(`packs: ${written.packs}`);
  console.log(`unsure: ${written.unsure}`);
  console.log(`report: ${written.report}`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
