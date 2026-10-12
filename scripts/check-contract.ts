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
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContractText, parseDocumentFields } from '../src/product/contract.js';

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

const USAGE = 'usage: bun run contract:check [--cases <file>] [--documents <file>] [--products <folder>] [--src <file>]';
const DEFAULT_CASES = fileURLToPath(new URL('../examples/contract/registry-cases.json', import.meta.url));
const DEFAULT_DOCUMENT_CASES = fileURLToPath(new URL('../examples/contract/document-cases.json', import.meta.url));
const DEFAULT_PRODUCTS = fileURLToPath(new URL('../examples/contract/', import.meta.url));

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
function checkDocCase(one: DocumentCase, verdicts: CaseVerdict[]): void {
  if (one.text === null || one.text === undefined) {
    verdicts.push({ case: `document ${one.name}`, problems: ["the case carries no text: every example holds the document's whole Markdown"] });
    return;
  }
  const read = parseDocumentFields('docs/example.md', one.text);
  if (one.ok !== undefined && one.ok !== null) {
    if (!read.ok) {
      verdicts.push({ case: `document ${one.name}`, problems: [`expected the fields to read, got refused: ${read.errors.map((e) => `${e.file}:${e.line}: ${e.message}`).join('; ')}`] });
      return;
    }
    const problems: string[] = [];
    for (const [field, expected] of Object.entries(one.ok)) {
      const held = (read.fields as unknown as Record<string, unknown>)[field];
      if (JSON.stringify(held) !== JSON.stringify(expected)) problems.push(`field ${field} expected ${JSON.stringify(expected)}, got ${JSON.stringify(held)}`);
    }
    verdicts.push({ case: `document ${one.name}`, problems });
    return;
  }
  const named = read.ok
    ? false
    : read.errors.some((error) => error.line === (one.line ?? 1) && error.message.includes(one.message!) && (one.path === undefined || error.path === one.path));
  if (!named) {
    const held = read.ok ? 'read as ok' : read.errors.map((error) => `${error.path || '-'}:${error.line}: ${error.message}`).join('; ');
    verdicts.push({ case: `document ${one.name}`, problems: [`expected a refusal on line ${one.line ?? 1} naming ${JSON.stringify(one.message)}${one.path === undefined ? '' : ` at ${one.path}`}, got ${held}`] });
  }
}

function run(casesPath: string, documentCasesPath: string, productsRoot: string, sourcePath: string | undefined): number {
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
  for (const one of file.cases) checkCase(one);
  const docFile = JSON.parse(readFileSync(documentCasesPath, 'utf8')) as { cases: DocumentCase[] };
  for (const one of docFile.cases) checkDocCase(one, verdicts);
  let failed = 0;
  for (const verdict of verdicts) {
    if (verdict.problems.length === 0) continue;
    failed++;
    for (const problem of verdict.problems) console.error(`error: case ${verdict.case}: ${problem}`);
  }
  const products = verdicts.filter((v) => v.case.startsWith('product ')).length;
  console.log(`contract: ${file.cases.length} registry cases, ${docFile.cases.length} document cases, ${products} products, ${failed} misread`);
  return failed > 0 ? 1 : 0;
}

let casesPath = DEFAULT_CASES;
let documentCasesPath = DEFAULT_DOCUMENT_CASES;
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
process.exitCode = run(casesPath, documentCasesPath, productsRoot, sourcePath);
