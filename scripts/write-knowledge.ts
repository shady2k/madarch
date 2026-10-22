#!/usr/bin/env bun
/**
 * Writes the product page and the domain pages of a product repository with a
 * real coding agent (decision 0029; madarch-m38l.2).
 *
 *   bun scripts/write-knowledge.ts --repository <code repository> --output <product repository> \
 *     --product-name "<name>" --agent claude-code|codex [--store <folder>] [--ref <revision>]
 *
 * It fills the temporal graph from the code repository (a second call with
 * the same store writes no row), puts the text files into the graph, then runs
 * one agent unit for the product and one per domain the product page
 * declares. The agent reads only through the graph's tools. Each unit is one
 * agent session on the person's own agent account: a real run costs the
 * product unit plus one unit per domain, each within 272K tokens of context
 * (a wrap-up at 70%, a stop at 80%), 30 turns and 10 minutes, and needs the
 * owner's explicit yes (the agent, and the cap).
 *
 * Pages are written to <output>/docs/product.md and <output>/docs/domains/<slug>.md.
 * Exit 0 when every page was written, 1 when a unit failed, 2 on a wrong argument.
 */
import { parseArgs } from 'node:util';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { fillGraph } from '../src/extract/driver/index.js';
import { HISTORY_EXTRACTOR, OWNERS, TREE_EXTRACTORS } from '../src/extract/driver/extractors.js';
import { createGraphStore } from '../src/graph/index.js';
import { ACP_ADAPTERS, acpAdapterBinFolder, acpAgentFolder } from '../src/fill/acp-probe.js';
import { resolveExecutable } from '../src/fill/acp.js';
import { acpUnitAgent, runWriter } from '../src/writer/index.js';

const { values } = parseArgs({
  options: {
    repository: { type: 'string' },
    output: { type: 'string' },
    'product-name': { type: 'string' },
    agent: { type: 'string' },
    store: { type: 'string' },
    ref: { type: 'string' },
  },
});
const fail = (message: string): never => { console.error(`write-knowledge: ${message}`); process.exit(2); };
if (values.repository === undefined || values.output === undefined || values['product-name'] === undefined || values.agent === undefined) {
  fail('usage: --repository <code repository> --output <product repository> --product-name <name> --agent claude-code|codex [--store <folder>] [--ref <revision>]');
}
const repository = path.resolve(values.repository!);
const output = path.resolve(values.output!);
const entry = ACP_ADAPTERS.find((adapter) => adapter.id === values.agent);
if (entry === undefined) fail(`--agent ${values.agent} is none of ${ACP_ADAPTERS.map((a) => a.id).join(', ')}`);
const searchPath = `${acpAdapterBinFolder(acpAgentFolder(entry!))}${path.delimiter}${process.env.PATH ?? ''}`;
const launch = entry!.launches.find((candidate) => resolveExecutable(candidate.binary, searchPath) !== undefined);
if (launch === undefined) fail(`the ${entry!.label} adapter is not installed: none of ${entry!.launches.map((l) => l.binary).join(', ')} is on the PATH or in ${acpAgentFolder(entry!)}`);

if (values.store !== undefined) mkdirSync(path.resolve(values.store), { recursive: true });
const owner = createPGliteDatabaseOwner({ btreeGist: true, ...(values.store === undefined ? {} : { path: path.resolve(values.store) }) });
const store = createGraphStore(owner);
await owner.ready;
await store.createSchema();
const agent = acpUnitAgent({ spec: { id: entry!.id, command: launch!.binary, args: launch!.args }, env: { PATH: searchPath }, progress: (line) => console.log(line) });
try {
  console.log(`Filling the graph from ${repository} (a second fill of the same store writes nothing).`);
  const snapshots = {};
  await fillGraph({ owner, store, repository, ...(values.ref === undefined ? {} : { ref: values.ref }), extractors: TREE_EXTRACTORS, owners: OWNERS, history: HISTORY_EXTRACTOR, snapshots });
  const report = await runWriter({
    owner, store, repository, ...(values.ref === undefined ? {} : { ref: values.ref }), output, productName: values['product-name']!, agent,
    onUnit: (o) => console.log(`${o.unit}: ${o.status} (${o.writeAttempts} write attempts, ${o.calls} tool calls) ${o.path}`),
  });
  console.log(`${report.units} agent units; ${report.ok ? 'every page written' : 'some pages were not written'}; ${report.content.stored} files stored in the graph, ${report.content.skipped.length} skipped.`);
  for (const unit of [report.product, ...report.domains]) for (const refusal of unit.refusals) console.log(`  ${unit.unit}: line ${refusal.line} ${refusal.rule}: ${refusal.message}`);
  for (const page of report.stale) console.log(`  not written by this run, left alone: ${page}`);
  console.log(`Pages are in ${output}/docs; open the product repository's wiki to read them.`);
  process.exitCode = report.ok ? 0 : 1;
} finally {
  await agent.close();
  await owner.close();
}
