#!/usr/bin/env bun
/**
 * Rebuilds the graph index of a product's Markdown pages (decision 0029;
 * madarch-m38l.8) and prints what it holds.
 *
 *   bun scripts/index-knowledge.ts --product <product repository> --repository <code repository> --store <graph store folder> [--ref <revision>]
 *
 * The store is the one the fill and the writer used. The command reads the
 * pages of the product repository and publishes pages, statements, grounds,
 * mentions and document sections to the graph; a second call with the same
 * Markdown writes nothing. It then prints the statements whose grounds
 * changed since their page was written. Exit 0 when every ground resolved,
 * 1 when some did not (each is listed with its file and line), 2 on a wrong
 * argument.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore } from '../src/graph/index.js';
import { changedGrounds, gitReader, indexCounts, indexProductMarkdown } from '../src/knowledge/index/index.js';
import { readProduct } from '../src/product/manifest.js';
import { GraphView } from '../src/writer/index.js';

const { values } = parseArgs({ options: { product: { type: 'string' }, repository: { type: 'string' }, store: { type: 'string' }, ref: { type: 'string' } } });
const fail = (message: string): never => { console.error(`index-knowledge: ${message}`); process.exit(2); };
if (values.product === undefined || values.repository === undefined || values.store === undefined) fail('usage: --product <product repository> --repository <code repository> --store <graph store folder> [--ref <revision>]');
const productFolder = path.resolve(values.product!);
const repository = path.resolve(values.repository!);
const read = readProduct(productFolder);
if (!read.ok) fail(`${read.file}:${read.line}: ${read.message}`);
const identity = (read as Extract<typeof read, { ok: true }>).product;
const head = execFileSync('git', ['rev-parse', values.ref ?? 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
const git = gitReader(repository);

const owner = createPGliteDatabaseOwner({ btreeGist: true, path: path.resolve(values.store!) });
const store = createGraphStore(owner);
await owner.ready;
await store.createSchema();
try {
  const view = await GraphView.open(owner, store);
  const report = await indexProductMarkdown({
    owner, store, productFolder, productId: identity.id, at: view.at, head: { commit: head, git },
    repositories: (name) => (name === path.basename(repository) ? git : undefined),
  });
  console.log(`Indexed ${report.pages} pages, ${report.statements} statements, ${report.grounds} grounds, ${report.mentions} mentions, ${report.relates} relations and ${report.sections} document sections${report.unchanged ? ' (the graph already held exactly this)' : ''}.`);
  for (const count of await indexCounts(owner)) console.log(`  ${count.kind}: ${count.pages} pages, ${count.statements} statements`);
  const changed = (await changedGrounds(owner, { commit: head, git })).filter((change) => change.status === 'changed' || change.status === 'removed');
  console.log(changed.length === 0 ? 'No ground has changed since its page was written.' : `${changed.length} grounds changed since their page was written:`);
  for (const change of changed) console.log(`  ${change.page} ${change.statement} (${change.status}): ${change.ground}`);
  for (const miss of report.unresolved) console.error(`  ${miss.file}:${miss.line}: ${miss.reason}`);
  process.exitCode = report.unresolved.length === 0 ? 0 : 1;
} finally {
  await owner.close();
}
