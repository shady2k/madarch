#!/usr/bin/env bun
/**
 * The handback command: generate the training repository, make its product, let
 * the deterministic fill settle, then run the committed answer-key check. No
 * real agent is used; the fill is the product's own scripted path.
 *
 *   bun scripts/answer-key-check-training.ts [--work <folder>] [--out <folder>]
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultAnswerKeyFile, defaultQuestionKeyFile, reportText, runAnswerKeyCheck } from '../src/knowledge/answer-key-check.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { generateTrainingRepository, makeProduct, ROOT, writeSamplePages } from '../test/knowledge-fixture.js';

interface Options {
  work: string;
  out: string;
  help: boolean;
}

function fail(message: string): never {
  const script = resolve(process.argv[1] ?? 'scripts/answer-key-check-training.ts');
  throw new Error(`${script}:1: ${message}; full path ${script}`);
}

function usage(): string {
  return [
    'answer-key check on a freshly filled training product',
    '',
    '  --work <folder>   scratch folder (default: /tmp/madarch-answer-key-check)',
    '  --out <folder>    output folder (default: out/answer-key-j6ho2)',
    '  --help            print this help',
  ].join('\n');
}

function parse(argv: readonly string[]): Options {
  const options: Options = { work: '/tmp/madarch-answer-key-check', out: resolve(ROOT, 'out/answer-key-j6ho2'), help: false };
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (flag === '--work') options.work = value ?? '';
    else if (flag === '--out') options.out = value ?? '';
    else fail(`unknown argument ${flag ?? ''}`);
    if (value === undefined || value === '') fail(`missing value after ${flag}`);
    index += 2;
  }
  if (!options.help && options.work === '') fail('--work cannot be empty');
  return options;
}

async function fill(work: string): Promise<{ productFolder: string; storeRoot: string }> {
  const repository = join(work, 'repository');
  const home = join(work, 'home');
  const storeRoot = join(work, 'store');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  generateTrainingRepository(repository);
  const productFolder = makeProduct(home, 'training-shop', repository);
  writeSamplePages(productFolder);
  const product = new KnowledgeProduct({ productFolder, storeRoot });
  try {
    await product.startFill();
    await product.settled();
    const status = await product.status();
    const pages = status.kinds.reduce((total, kind) => total + kind.count, 0);
    console.log(`fill settled: ${status.kinds.length} kinds, ${pages} pages`);
  } finally {
    await product.close();
  }
  return { productFolder, storeRoot };
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const work = resolve(options.work);
  const { productFolder, storeRoot } = await fill(work);
  const { check, written } = await runAnswerKeyCheck({
    productFolder,
    storeRoot,
    keyFile: defaultAnswerKeyFile(ROOT),
    questionKeyFile: defaultQuestionKeyFile(ROOT),
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
