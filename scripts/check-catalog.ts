#!/usr/bin/env bun
/**
 * `bun run check:catalog` (decision 0033, items 8 to 10): the mechanical check of the entity catalog
 * the starter set holds, run over the starter set exactly as `madarch new` writes it.
 *
 *   bun run check:catalog                    the starter set, written into a temporary product and checked
 *   bun run check:catalog --folder <folder>  the catalog of a product folder that already exists
 *
 * The command reads the manifest the way the wiki reads it — the same reader
 * (`src/knowledge/kinds.ts`, which calls the catalog's reader in
 * `src/knowledge/catalog.ts`) — and reports the catalog's own findings only:
 * the product's documents and their expectations are the product's matter,
 * not the catalog's. A finding is printed as `<full path>:<line>: <the words>`,
 * naming the kind it is about, and the command exits 1; a run that finds
 * nothing names the counts and exits 0. Arguments it does not understand
 * exit 2.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readKinds } from '../src/knowledge/kinds.js';
import { seedStarterSet } from '../src/knowledge/seed.js';

const USAGE = 'usage: bun run check:catalog [--folder <product folder>]';

function fail(message: string): never {
  console.error(`${resolve(process.argv[1] ?? 'scripts/check-catalog.ts')}:1: ${message}`);
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
  const folder = mkdtempSync(join(tmpdir(), 'madarch-catalog-'));
  seedStarterSet(folder);
  return { folder, temporary: true };
}

function main(): void {
  const { folder, temporary } = folderOf(process.argv.slice(2));
  try {
    const read = readKinds(folder);
    if (!read.present) fail(`${join(folder, 'madarch', 'kinds.yaml')}: the product holds no kinds manifest, and the starter set writes one`);
    const manifest = read.manifest;
    const catalog = manifest.catalog;
    if (catalog === undefined) fail(`${manifest.file}: the manifest declares no "catalog", and the starter set holds the whole entity catalog`);
    let failed = false;
    // Every finding of the manifest is the catalog check's, except the ones that say what a product's documents
    // lack: a product made a minute ago holds no documents, and those findings are the wiki's answer to its reader.
    const documentExpectation = '"documents.expect" names the kind';
    for (const finding of manifest.findings) {
      if (finding.message.startsWith(documentExpectation)) continue;
      console.error(`${finding.file}:${finding.line}: ${finding.message}`);
      failed = true;
    }
    // A page kind the catalog holds and the wiki does not show is a kind whose own page fields were refused: the
    // manifest's finding names the field, and the catalog's check says the page is missing rather than passing quietly.
    for (const entry of catalog.kinds.values()) {
      if (entry.templatePolicy === 'none' || manifest.kinds.has(entry.name)) continue;
      const why = manifest.findings.find((finding) => finding.message.startsWith(`kind "${entry.name}":`));
      console.error(`${manifest.file}:${entry.line}: kind "${entry.name}": its page is not read${why === undefined ? '' : `: ${why.message}`}`);
      failed = true;
    }
    const areas = [...manifest.groups.values()].filter((group) => group.parent === undefined);
    const subgroups = [...manifest.groups.values()].filter((group) => group.parent !== undefined);
    const kinds = [...catalog.kinds.values()];
    const shown = kinds.filter((kind) => kind.templatePolicy !== 'none');
    console.log(
      `catalog: ${areas.length} areas, ${subgroups.length} subgroups, ${kinds.length} kinds (${shown.length} with a page of their own or a member's row); ${manifest.file}`,
    );
    // The mapping's own counts: what is tied to the catalog, and what the extractors keep as their own.
    const mapping = manifest.mapping;
    if (mapping === undefined) {
      console.error(`${manifest.file}:1: the manifest declares no "mapping", and the starter set ties the extractors' vocabulary to the catalog`);
      failed = true;
    }
    else {
      const tied = (rows: Iterable<{ tie: string }>): [number, number] => {
        let mapped = 0;
        let internal = 0;
        for (const row of rows) {
          if (row.tie === 'internal') internal += 1;
          else mapped += 1;
        }
        return [mapped, internal];
      };
      const [kindMapped, kindInternal] = tied(mapping.kinds.values());
      const [relationMapped, relationInternal] = tied(mapping.relations.values());
      console.log(
        `mapping: version ${mapping.version}; ${mapping.kinds.size} extractor kinds (${kindMapped} tied to a catalog kind, ${kindInternal} internal); ${mapping.relations.size} extractor relations (${relationMapped} tied to a catalog relation, ${relationInternal} internal)`,
      );
      if (mapping.findings.length > 0) {
        for (const finding of mapping.findings) console.error(`${finding.file}:${finding.line}: ${finding.message}`);
        failed = true;
      }
    }
    if (failed) process.exit(1);
  } finally {
    if (temporary) rmSync(folder, { recursive: true, force: true });
  }
}

main();
