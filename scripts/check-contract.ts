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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContractText, parseDocumentFields } from '../src/product/contract.js';
import { readProduct } from '../src/product/manifest.js';

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
  /**
   * The honest-finding cases (the 0021 amendment's reservations): a case
   * that reads, whose reservations the engine keeps and names — each as an
   * expected finding's line, field path and words, all to hold at once.
   */
  reservations?: { line?: number; path?: string; message: string }[];
}

const USAGE = 'usage: bun run contract:check [--cases <file>] [--documents <file>] [--manifest-cases <file>] [--products <folder>] [--src <file>]';
const DEFAULT_CASES = fileURLToPath(new URL('../examples/contract/registry-cases.json', import.meta.url));
const DEFAULT_MANIFEST_CASES = fileURLToPath(new URL('../examples/contract/manifest-cases.json', import.meta.url));
const DEFAULT_DOCUMENT_CASES = fileURLToPath(new URL('../examples/contract/document-cases.json', import.meta.url));
const DEFAULT_PRODUCTS = fileURLToPath(new URL('../examples/contract/', import.meta.url));

/** One manifest case as the examples hold it: a manifest's text, the identity it reads as or the refusal with the line and the words. */
interface ManifestCase {
  name: string;
  text: string | null;
  folder?: string;
  ok?: Record<string, unknown>;
  line?: number;
  message?: string;
}

interface ManifestCaseSuite {
  folder: string;
  cases: ManifestCase[];
}

/** Runs every manifest case in the scratch folder the run makes itself, and records the verdicts. */
function checkManifestCases(suite: ManifestCaseSuite, verdicts: CaseVerdict[], from: string): void {
  const root = mkdtempSync(join(tmpdir(), 'contract-manifest-'));
  for (const one of suite.cases) {
    const problems: string[] = [];
    try {
      if (one.text === undefined) {
        problems.push('the case carries no text: every example holds the manifest file\'s whole text, or null for a folder holding none');
      } else {
        const folder = join(root, one.folder ?? suite.folder ?? 'idea-2026-10-09');
        mkdirSync(folder, { recursive: true });
        if (one.text !== null) writeFileSync(join(folder, 'workspace.yaml'), one.text);
        const read = readProduct(folder);
        if (one.ok !== undefined && one.ok !== null) {
          if (!read.ok) {
            problems.push(`expected to read, got refused at ${read.file}:${read.line}: ${read.message}`);
          } else {
            const product = read.product as unknown as Record<string, unknown>;
            for (const [field, expected] of Object.entries(one.ok)) {
              if (JSON.stringify(product[field]) !== JSON.stringify(expected)) {
                problems.push(`field ${field} expected ${JSON.stringify(expected)}, got ${JSON.stringify(product[field])}`);
              }
            }
          }
        } else if (read.ok) {
          problems.push(`expected a refusal naming ${one.message ?? ''}, got read as ok`);
        } else if (read.line !== (one.line ?? 1) || !read.message.includes(one.message ?? '')) {
          problems.push(`expected a refusal on line ${one.line ?? 1} naming ${JSON.stringify(one.message ?? '')}, got ${read.file}:${read.line}: ${read.message}`);
        }
      }
    } finally {
      for (const entry of readdirSync(root)) rmSync(join(root, entry), { recursive: true, force: true });
    }
    verdicts.push({ case: `manifest ${one.name}`, from, problems });
  }
}

/** One check: whether one case agrees with the reading, and the words either way. */
interface CaseVerdict {
  case: string;
  /** The path of the cases file the case came from; absent for a product folder the walk found on disk. */
  from?: string;
  problems: string[];
}

const verdicts: CaseVerdict[] = [];

/** Runs one contract case and records the mismatch's file, line and words. */
function checkCase(one: ContractCase, from: string): void {
  if (one.text === null || one.text === undefined) {
    verdicts.push({ case: one.name, from, problems: [`the case ${one.name} carries no text: every example holds the registry file's whole text`] });
    return;
  }
  const read = parseContractText('docs/kinds.yaml', one.text);
  if (one.reservations !== undefined) {
    const problems: string[] = [];
    if (!read.ok) {
      const first = read.errors[0];
      problems.push(`expected the registry to read, got refused at ${first.file}:${first.line}: ${first.message}`);
      verdicts.push({ case: one.name, from, problems });
      return;
    }
    const held = read.reservations;
    for (const expected of one.reservations) {
      const named = held.some((finding: ReservationFinding) =>
        finding.line === (expected.line ?? 1) &&
        finding.message.includes(expected.message) &&
        (expected.path === undefined || finding.path === expected.path));
      if (!named) {
        const shown = held.map((finding: ReservationFinding) => `${finding.path}:${finding.line}: ${finding.message}`).join('; ');
        problems.push(`expected a reservation on line ${expected.line ?? 1} naming ${JSON.stringify(expected.message)}${expected.path === undefined ? '' : ` at ${expected.path}`}, got ${shown}`);
      }
    }
    const spare = one.reservations.length === 0 ? held.length : 0;
    if (spare !== 0) problems.push(`expected no further reservations, got ${spare}: ${held.map((f: ReservationFinding) => f.message).join('; ')}`);
    verdicts.push({ case: one.name, from, problems });
    return;
  }
  if (one.message === undefined) {
    if (!read.ok) {
      const first = read.errors[0];
      verdicts.push({ case: one.name, from, problems: [`expected the registry to read, got refused at ${first.file}:${first.line}: ${first.message}`] });
    } else {
      verdicts.push({ case: one.name, from, problems: [] });
    }
    return;
  }
  if (read.ok) {
    verdicts.push({ case: one.name, from, problems: [`expected a refusal naming ${one.message}, got read as ok`] });
    return;
  }
  const named = read.errors.some((error) => error.line === (one.line ?? 1) && error.message.includes(one.message!) && (one.path === undefined || error.path === one.path));
  if (!named) {
    const held = read.errors.map((error) => `${error.path || '-'}:${error.line}: ${error.message}`).join('; ');
    verdicts.push({ case: one.name, from, problems: [`expected a refusal on line ${one.line ?? 1} naming ${JSON.stringify(one.message)}${one.path === undefined ? '' : ` at ${one.path}`}, got ${held}`] });
    return;
  }
  verdicts.push({ case: one.name, from, problems: [] });
}


/** The folders every product holds, the manifest's schemaVersion fixing the layout. */
const LAYOUT = ['workspace.yaml', 'docs', 'model', 'repos'] as const;

/** Every Markdown file under one folder, at any depth, in code point order of their paths. */
function markdownUnder(folder: string): string[] {
  const out: string[] = [];
  const walk = (current: string, within: string): void => {
    for (const name of readdirSync(current).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full, within === '' ? name : `${within}/${name}`);
      else if (name.endsWith('.md')) out.push(within === '' ? name : `${within}/${name}`);
    }
  };
  if (!existsSync(folder)) return out;
  walk(folder, '');
  return out;
}

/** Checks one example product folder the way a reader walks it: the layout, then every document's fields, then the registry when the product holds one. */
function checkProductFolder(root: string, name: string, verdicts: CaseVerdict[]): void {
  const folder = join(root, name);
  const problems: string[] = [];
  for (const place of LAYOUT) {
    if (!existsSync(join(folder, place))) problems.push(`the layout's ${place} is missing`);
  }
  const manifest = join(folder, 'workspace.yaml');
  if (existsSync(manifest)) {
    const first = readFileSync(manifest, 'utf8').split('\n')[0]?.trim();
    if (first !== 'schemaVersion: 1') problems.push(`${name}/workspace.yaml: the first line is ${JSON.stringify(first)}, not "schemaVersion: 1"`);
    // The example's manifest is the manifest reader's input, whoever made
    // the folder: the same reading `madarch serve` and `madarch list` sit on.
    const read = readProduct(folder);
    if (!read.ok) problems.push(`${name}/workspace.yaml: refused at ${read.file}:${read.line}: ${read.message}`);
  }
  for (const path of markdownUnder(join(folder, 'docs'))) {
    const read = parseDocumentFields(`${name}/docs/${path}`, readFileSync(join(folder, 'docs', path), 'utf8'));
    if (!read.ok) {
      for (const error of read.errors) problems.push(`${error.file}:${error.line}: ${error.path}: ${error.message}`);
    }
  }
  const registry = join(folder, 'docs', 'kinds.yaml');
  if (existsSync(registry)) {
    const read = parseContractText(`${name}/docs/kinds.yaml`, readFileSync(registry, 'utf8'));
    if (!read.ok) {
      for (const error of read.errors) problems.push(`${error.file}:${error.line}: ${error.path}: ${error.message}`);
    }
  }
  verdicts.push({ case: `product ${name}`, problems });
}


/** One document case as the examples hold it: its text, the fields it expects or the refusal with the line and the words. */
interface DocumentCase {
  name: string;
  text: string | null;
  ok?: Record<string, unknown>;
  line?: number;
  path?: string;
  message?: string;
}

/** Runs one document-fields case and records the mismatch's words. */
function checkDocCase(one: DocumentCase, verdicts: CaseVerdict[], from: string): void {
  if (one.text === null || one.text === undefined) {
    verdicts.push({ case: `document ${one.name}`, from, problems: ["the case carries no text: every example holds the document's whole Markdown"] });
    return;
  }
  const read = parseDocumentFields('docs/example.md', one.text);
  if (one.ok !== undefined && one.ok !== null) {
    if (!read.ok) {
      verdicts.push({ case: `document ${one.name}`, from, problems: [`expected the fields to read, got refused: ${read.errors.map((e) => `${e.file}:${e.line}: ${e.message}`).join('; ')}`] });
      return;
    }
    const problems: string[] = [];
    for (const [field, expected] of Object.entries(one.ok)) {
      const held = (read.fields as unknown as Record<string, unknown>)[field];
      if (JSON.stringify(held) !== JSON.stringify(expected)) problems.push(`field ${field} expected ${JSON.stringify(expected)}, got ${JSON.stringify(held)}`);
    }
    verdicts.push({ case: `document ${one.name}`, from, problems });
    return;
  }
  const named = read.ok
    ? false
    : read.errors.some((error) => error.line === (one.line ?? 1) && error.message.includes(one.message!) && (one.path === undefined || error.path === one.path));
  if (!named) {
    const held = read.ok ? 'read as ok' : read.errors.map((error) => `${error.path || '-'}:${error.line}: ${error.message}`).join('; ');
    verdicts.push({ case: `document ${one.name}`, from, problems: [`expected a refusal on line ${one.line ?? 1} naming ${JSON.stringify(one.message)}${one.path === undefined ? '' : ` at ${one.path}`}, got ${held}`] });
  }
}

function run(casesPath: string, documentCasesPath: string, manifestCasesPath: string, productsRoot: string, sourcePath: string | undefined): number {
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
  for (const name of readdirSync(productsRoot).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!statSync(join(productsRoot, name)).isDirectory()) continue;
    checkProductFolder(productsRoot, name, verdicts);
  }
  for (const one of file.cases) checkCase(one, casesPath);
  const manifestSuite = JSON.parse(readFileSync(manifestCasesPath, 'utf8')) as ManifestCaseSuite;
  checkManifestCases(manifestSuite, verdicts, manifestCasesPath);
  const docFile = JSON.parse(readFileSync(documentCasesPath, 'utf8')) as { cases: DocumentCase[] };
  for (const one of docFile.cases) checkDocCase(one, verdicts, documentCasesPath);
  let failed = 0;
  for (const verdict of verdicts) {
    if (verdict.problems.length === 0) continue;
    failed++;
    for (const problem of verdict.problems) {
      const where = verdict.from === undefined ? '' : ` (${verdict.from})`;
      console.error(`error: case ${verdict.case}${where}: ${problem}`);
    }
  }
  const products = verdicts.filter((v) => v.case.startsWith('product ')).length;
  const manifestCases = verdicts.filter((v) => v.case.startsWith('manifest ')).length;
  console.log(`contract: ${file.cases.length} registry cases, ${docFile.cases.length} document cases, ${manifestCases} manifest cases, ${products} products, ${failed} misread`);
  return failed > 0 ? 1 : 0;
}

let casesPath = DEFAULT_CASES;
let documentCasesPath = DEFAULT_DOCUMENT_CASES;
let manifestCasesPath = DEFAULT_MANIFEST_CASES;
let productsRoot = DEFAULT_PRODUCTS;
let sourcePath: string | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i];
  const value = args[i + 1];
  if (flag === '--cases') {
    casesPath = value!;
    continue;
  }
  if (flag === '--manifest-cases') {
    manifestCasesPath = value!;
    continue;
  }
  if (flag === '--documents') {
    documentCasesPath = value!;
    continue;
  }
  if (flag === '--products') {
    productsRoot = value!;
    continue;
  }
  if (flag === '--src') {
    sourcePath = value;
    continue;
  }
  console.error(`error: ${USAGE}`);
  process.exit(2);
}
process.exitCode = run(casesPath, documentCasesPath, manifestCasesPath, productsRoot, sourcePath);
