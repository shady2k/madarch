#!/usr/bin/env bun
/**
 * Graph verdicts on a freshly filled training product (madarch-mwhd.1): every
 * current node and edge gets valid, invalid or unreviewed with a reason. The
 * run is deterministic unless a model role is assigned; the training product
 * has no writer choice, so the default budgets allow no judge and every
 * undecided item says no judge is assigned. No real agent is used.
 *
 *   bun scripts/graph-verdicts.ts [--work <folder>] [--out <folder>]
 *       [--items-per-run <n>] [--model-calls-per-run <n>]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { generateTrainingRepository, makeProduct, ROOT, writeSamplePages } from '../test/knowledge-fixture.js';

interface Options {
  work: string;
  out: string;
  itemsPerRun: number;
  modelCallsPerRun: number;
  help: boolean;
}

function fail(message: string): never {
  const script = resolve(process.argv[1] ?? 'scripts/graph-verdicts.ts');
  throw new Error(`${script}:1: ${message}; full path ${script}`);
}

function usage(): string {
  return [
    'graph verdicts on a freshly filled training product',
    '',
    '  --work <folder>              scratch folder (default: /tmp/madarch-graph-verdicts)',
    '  --out <folder>               output folder (default: out/graph-verdicts-mwhd1)',
    '  --items-per-run <n>          items one run may judge (default: 400)',
    '  --model-calls-per-run <n>    judge calls one run may make (default: 0)',
    '  --help                       print this help',
  ].join('\n');
}

function whole(flag: string, value: string | undefined): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) fail(`${flag} is ${JSON.stringify(value)}: a whole number, 0 or more`);
  return number;
}

function parse(argv: readonly string[]): Options {
  const options: Options = {
    work: '/tmp/madarch-graph-verdicts',
    out: resolve(ROOT, 'out/graph-verdicts-mwhd1'),
    itemsPerRun: 400,
    modelCallsPerRun: 0,
    help: false,
  };
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') { options.help = true; index += 1; continue; }
    const value = argv[index + 1];
    if (flag === '--work') options.work = value ?? '';
    else if (flag === '--out') options.out = value ?? '';
    else if (flag === '--items-per-run') options.itemsPerRun = whole(flag, value);
    else if (flag === '--model-calls-per-run') options.modelCallsPerRun = whole(flag, value);
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
  if (options.help) { console.log(usage()); return; }
  const work = resolve(options.work);
  const out = resolve(options.out);
  const { productFolder, storeRoot } = await fill(work);
  const product = new KnowledgeProduct({ productFolder, storeRoot });
  try {
    const saved = product.setGraphVerdictBudgets(options.itemsPerRun, options.modelCallsPerRun);
    if (!saved.ok) fail(saved.message);
    const view = await product.graphVerdicts({ force: true });
    const { report } = view;
    const missing = report.byKind.reduce((total, kind) => total + kind.total, 0);
    if (missing !== report.totals.items) fail(`the report names ${missing} items by kind but ${report.totals.items} in all`);
    if (report.totals.valid + report.totals.invalid + report.totals.unreviewed !== report.totals.items) fail('the verdict counts do not add up to the items');
    const unreasoned = view.rows.filter((row) => row.reason.trim() === '');
    if (unreasoned.length > 0) fail(`${unreasoned.length} items have no reason`);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'graph-verdicts.json'), `${JSON.stringify({ file: view.file, budgets: view.budgets, metrics: view.metrics, report, rows: view.rows }, null, 2)}\n`);
    writeFileSync(join(out, 'graph-verdicts-coverage.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(out, 'graph-verdicts-invalid.json'), `${JSON.stringify(view.rows.filter((row) => row.verdict === 'invalid'), null, 2)}\n`);
    writeFileSync(join(out, 'graph-verdicts-unreviewed.json'), `${JSON.stringify(view.rows.filter((row) => row.verdict === 'unreviewed'), null, 2)}\n`);
    console.log(`graph verdicts: ${report.totals.items} items (${report.totals.nodes} nodes, ${report.totals.edges} edges)`);
    console.log(`valid: ${report.totals.valid}, invalid: ${report.totals.invalid}, unreviewed: ${report.totals.unreviewed}`);
    console.log(`cached: ${view.cached}, judged: ${view.metrics.judgeItems}, model calls: ${view.metrics.modelCalls}`);
    for (const kind of report.byKind) console.log(`  ${kind.role} ${kind.kind}: ${kind.total} (valid ${kind.valid}, invalid ${kind.invalid}, unreviewed ${kind.unreviewed})`);
    console.log(`report: ${join(out, 'graph-verdicts.json')}`);
  } finally {
    await product.close();
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
