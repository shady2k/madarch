#!/usr/bin/env bun
/**
 * `bun scripts/check-reference-graph.ts <repository>` — the mechanical check of
 * the reference graph in `examples/training-repository/reference-graph/`
 * against the generated training repository.
 *
 *   bun scripts/check-reference-graph.ts /work/out/training
 *   bun scripts/check-reference-graph.ts /work/out/training --graph <folder>
 *
 * Every finding is printed as `<full path>:<line>: <the words>`, names the
 * reference file, the line of the entry, and — when it is about a quote — the
 * repository file and line the quote should equal. A run that finds nothing
 * names the counts and exits 0; findings exit 1; arguments it does not
 * understand exit 2.
 *
 * The rules:
 *  - the YAML parses, and every file's `path` mirrors its own place in the tree;
 *  - every tracked file of the repository has a reference file;
 *  - a node has `id`, `kind`, `label`, `evidence` and `reading`; `reading` is
 *    `parsed`, `declared` or `judgement`;
 *  - a kind is one the mapping ties to a catalog kind, and a relation is any
 *    key of src/knowledge/starter-mapping.ts (a relation the catalog ties, or
 *    one the mapping declares internal to extraction: the history and the
 *    environment have no catalog relation of their own); an id names its kind,
 *    `<kind>:<name>`;
 *  - every id is unique, and both ends of an edge exist;
 *  - a file's quote equals the file's lines at that path, at HEAD; a Git
 *    evidence item's quote is a line of the exact command's output.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { MAPPING_KIND_ROWS, MAPPING_RELATION_ROWS } from '../src/knowledge/starter-mapping.js';

const USAGE = 'usage: bun scripts/check-reference-graph.ts <repository folder> [--graph <reference folder>]';

class UsageError extends Error {}

interface FileEvidence {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly quote: string;
}

interface GitEvidence {
  readonly command: string;
  readonly quote: string;
}

type Evidence = FileEvidence | GitEvidence;

interface NodeEntry {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly evidence: readonly Evidence[];
  readonly reading: string;
}

interface EdgeEntry {
  readonly relation: string;
  readonly from: string;
  readonly to: string;
  readonly evidence: readonly Evidence[];
  readonly reading: string;
}

interface Document {
  readonly file: string;
  readonly path: string | undefined;
  readonly nodes: readonly NodeEntry[];
  readonly edges: readonly EdgeEntry[];
  readonly nodeLines: readonly number[];
  readonly edgeLines: readonly number[];
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

const KINDS = new Set(MAPPING_KIND_ROWS.filter((row) => row.kind !== undefined).map((row) => row.key));
// A relation may be one the catalog ties or one the mapping declares internal:
// the repository's history and environment have no catalog relation of their own.
const RELATIONS = new Set(MAPPING_RELATION_ROWS.map((row) => row.key));
const READINGS = new Set(['parsed', 'declared', 'judgement']);

function main(): number {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  let repository: string | undefined;
  let graph: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--graph') {
      graph = argv[index + 1];
      if (graph === undefined || graph.startsWith('--')) throw new UsageError('--graph names the reference folder, and none was given');
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new UsageError(`the argument ${JSON.stringify(argument)} is not one this command knows; --help lists them`);
    } else if (repository === undefined) {
      repository = argument;
    } else {
      throw new UsageError(`the argument ${JSON.stringify(argument)} is not one this command knows; --help lists them`);
    }
  }
  if (repository === undefined) throw new UsageError(USAGE);
  const root = resolve(repository);
  if (!existsSync(root)) throw new UsageError(`${root}: no such folder`);
  const graphRoot = resolve(graph ?? join(import.meta.dir, '..', 'examples', 'training-repository', 'reference-graph'));
  const findings: Finding[] = [];
  const documents = readDocuments(graphRoot, root, findings);
  checkVocabularyAndIds(documents, findings);
  const ids = new Set<string>();
  for (const document of documents) {
    checkEvidence(document, root, findings);
    for (const node of document.nodes) {
      if (typeof node.id === 'string') ids.add(node.id);
    }
  }
  const duplicates = new Map<string, string[]>();
  for (const document of documents) {
    for (const node of document.nodes) {
      if (typeof node.id !== 'string') continue;
      const owners = duplicates.get(node.id) ?? [];
      owners.push(document.file);
      duplicates.set(node.id, owners);
    }
  }
  for (const [id, owners] of duplicates) {
    if (owners.length > 1) findings.push({ file: owners[1]!, line: 1, message: `the id ${JSON.stringify(id)} is declared again; the first is in ${owners[0]}` });
  }
  for (const document of documents) {
    checkEdges(document, ids, findings);
    checkMirror(document, graphRoot, findings);
  }
  checkCoverage(graphRoot, root, findings);
  if (findings.length > 0) {
    for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.message}`);
    console.error(`${findings.length} finding${findings.length === 1 ? '' : 's'} in ${documents.length} reference files`);
    return 1;
  }
  const nodes = documents.reduce((sum, document) => sum + document.nodes.length, 0);
  const edges = documents.reduce((sum, document) => sum + document.edges.length, 0);
  console.log(`${documents.length} reference files, ${nodes} nodes, ${edges} edges: no findings`);
  return 0;
}

function usage(error: unknown): number {
  if (error instanceof UsageError) {
    console.error(`${resolve(process.argv[1] ?? 'scripts/check-reference-graph.ts')}:1: ${error.message}`);
    return 2;
  }
  throw error;
}

/** Every `*.yaml` below `graphRoot`, parsed with the YAML parser and with the line of each entry. */
function readDocuments(graphRoot: string, root: string, findings: Finding[]): Document[] {
  if (!existsSync(graphRoot)) {
    findings.push({ file: graphRoot, line: 1, message: 'the reference folder does not exist' });
    return [];
  }
  const files: string[] = [];
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.yaml')) files.push(path);
    }
  };
  walk(graphRoot);
  const documents: Document[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const lineCounter = new LineCounter();
    const parsed = parseDocument(source, { lineCounter });
    if (parsed.errors.length > 0) {
      for (const error of parsed.errors) {
        const pos = error.pos[0];
        findings.push({ file, line: lineCounter.linePos(pos).line, message: `the YAML does not parse: ${error.message}` });
      }
      continue;
    }
    const data = parsed.toJS() as { path?: unknown; nodes?: unknown; edges?: unknown; notes?: unknown } | null;
    if (data === null || typeof data !== 'object') {
      findings.push({ file, line: 1, message: 'the file holds no YAML mapping' });
      continue;
    }
    const nodes = Array.isArray(data.nodes) ? (data.nodes as NodeEntry[]) : [];
    const edges = Array.isArray(data.edges) ? (data.edges as EdgeEntry[]) : [];
    if (data.nodes !== undefined && !Array.isArray(data.nodes)) findings.push({ file, line: 1, message: '`nodes` is not a list' });
    if (data.edges !== undefined && !Array.isArray(data.edges)) findings.push({ file, line: 1, message: '`edges` is not a list' });
    if (!Array.isArray(data.nodes) && !Array.isArray(data.edges)) {
      findings.push({ file, line: 1, message: 'the file has neither `nodes` nor `edges`' });
    }
    const lineOf = (entry: unknown): number => {
      const key = entry as { range?: [number, number, number] } | null;
      return key?.range === undefined ? 1 : lineCounter.linePos(key.range[0]).line;
    };
    const nodeSeq = parsed.get('nodes', true);
    const edgeSeq = parsed.get('edges', true);
    const nodeItems = nodeSeq !== undefined && typeof nodeSeq === 'object' && 'items' in nodeSeq ? (nodeSeq.items as unknown[]) : [];
    const edgeItems = edgeSeq !== undefined && typeof edgeSeq === 'object' && 'items' in edgeSeq ? (edgeSeq.items as unknown[]) : [];
    documents.push({
      file,
      path: typeof data.path === 'string' ? data.path : undefined,
      nodes,
      edges,
      nodeLines: nodes.map((_node, index) => lineOf(nodeItems[index])),
      edgeLines: edges.map((_edge, index) => lineOf(edgeItems[index])),
    });
  }
  return documents;
}

function checkVocabularyAndIds(documents: readonly Document[], findings: Finding[]): void {
  for (const document of documents) {
    document.nodes.forEach((node, index) => {
      const line = document.nodeLines[index] ?? 1;
      if (typeof node !== 'object' || node === null) {
        findings.push({ file: document.file, line, message: 'a node is not a mapping' });
        return;
      }
      for (const field of ['id', 'kind', 'label'] as const) {
        if (typeof node[field] !== 'string' || node[field].length === 0) {
          findings.push({ file: document.file, line, message: `a node has no \`${field}\`` });
        }
      }
      if (!Array.isArray(node.evidence) || node.evidence.length === 0) {
        findings.push({ file: document.file, line, message: `the node ${JSON.stringify(node.id ?? '')} has no evidence` });
      }
      if (!READINGS.has(node.reading)) {
        findings.push({ file: document.file, line, message: `the node ${JSON.stringify(node.id ?? '')} reads as ${JSON.stringify(node.reading)}; parsed, declared or judgement are the readings` });
      }
      if (typeof node.kind !== 'string' || !KINDS.has(node.kind)) {
        findings.push({ file: document.file, line, message: `the node ${JSON.stringify(node.id ?? '')} has the kind ${JSON.stringify(node.kind)}; the mapping declares no such kind` });
      }
      if (typeof node.id === 'string' && typeof node.kind === 'string' && !node.id.startsWith(`${node.kind}:`)) {
        findings.push({ file: document.file, line, message: `the id ${JSON.stringify(node.id)} does not name its kind ${JSON.stringify(node.kind)}` });
      }
    });
    document.edges.forEach((edge, index) => {
      const line = document.edgeLines[index] ?? 1;
      if (typeof edge !== 'object' || edge === null) {
        findings.push({ file: document.file, line, message: 'an edge is not a mapping' });
        return;
      }
      for (const field of ['relation', 'from', 'to'] as const) {
        if (typeof edge[field] !== 'string' || edge[field].length === 0) {
          findings.push({ file: document.file, line, message: `an edge has no \`${field}\`` });
        }
      }
      if (!Array.isArray(edge.evidence) || edge.evidence.length === 0) {
        findings.push({ file: document.file, line, message: `the edge ${JSON.stringify(edge.relation ?? '')} has no evidence` });
      }
      if (!READINGS.has(edge.reading)) {
        findings.push({ file: document.file, line, message: `the edge ${JSON.stringify(edge.relation ?? '')} reads as ${JSON.stringify(edge.reading)}; parsed, declared or judgement are the readings` });
      }
      if (typeof edge.relation === 'string' && !RELATIONS.has(edge.relation)) {
        findings.push({ file: document.file, line, message: `the relation ${JSON.stringify(edge.relation)} is not one the mapping declares` });
      }
    });
  }
}

/** Quotes against the files at HEAD, and Git evidence against the command it names. */
function checkEvidence(document: Document, root: string, findings: Finding[]): void {
  const check = (evidence: Evidence, line: number, what: string): void => {
    if (typeof evidence !== 'object' || evidence === null) {
      findings.push({ file: document.file, line, message: `${what} has evidence that is not a mapping` });
      return;
    }
    if (typeof (evidence as GitEvidence).command === 'string') {
      const command = (evidence as GitEvidence).command;
      const quote = (evidence as GitEvidence).quote;
      if (typeof quote !== 'string') {
        findings.push({ file: document.file, line, message: `${what} has Git evidence without a \`quote\`` });
        return;
      }
      const output = gitOutput(root, command, findings, document.file, line, what);
      if (output === undefined) return;
      if (!output.split('\n').includes(quote)) {
        findings.push({ file: document.file, line, message: `${what}: the quote ${JSON.stringify(quote)} is not a line of \`${command}\` in ${root}` });
      }
      return;
    }
    const file = evidence as FileEvidence;
    if (typeof file.path !== 'string' || typeof file.startLine !== 'number' || typeof file.endLine !== 'number' || typeof file.quote !== 'string') {
      findings.push({ file: document.file, line, message: `${what} has an evidence item that is not { path, startLine, endLine, quote }` });
      return;
    }
    const full = join(root, file.path);
    if (!existsSync(full)) {
      findings.push({ file: document.file, line, message: `${what}: the evidence names ${full}, which does not exist` });
      return;
    }
    if (!Number.isInteger(file.startLine) || !Number.isInteger(file.endLine) || file.startLine < 1 || file.endLine < file.startLine) {
      findings.push({ file: document.file, line, message: `${what}: ${full}:${file.startLine}-${file.endLine} is not a line range` });
      return;
    }
    const lines = readFileSync(full, 'utf8').split('\n');
    if (file.endLine > lines.length) {
      findings.push({ file: document.file, line, message: `${what}: ${full}:${file.endLine} is past the file's ${lines.length} lines` });
      return;
    }
    const actual = lines.slice(file.startLine - 1, file.endLine).join('\n');
    if (actual !== file.quote) {
      findings.push({
        file: document.file,
        line,
        message: `${what}: the quote does not equal ${full}:${file.endLine === file.startLine ? file.startLine : `${file.startLine}-${file.endLine}`}\n    expected ${JSON.stringify(actual)}\n    quoted   ${JSON.stringify(file.quote)}`,
      });
    }
  };
  document.nodes.forEach((node, index) => {
    const line = document.nodeLines[index] ?? 1;
    const what = `the node ${JSON.stringify(node.id ?? '')}`;
    if (Array.isArray(node.evidence)) for (const item of node.evidence) check(item, line, what);
  });
  document.edges.forEach((edge, index) => {
    const line = document.edgeLines[index] ?? 1;
    const what = `the edge ${JSON.stringify(edge.relation ?? '')} ${JSON.stringify(edge.from ?? '')} -> ${JSON.stringify(edge.to ?? '')}`;
    if (Array.isArray(edge.evidence)) for (const item of edge.evidence) check(item, line, what);
  });
}

function gitOutput(root: string, command: string, findings: Finding[], file: string, line: number, what: string): string | undefined {
  const words = command.trim().split(/\s+/);
  if (words[0] !== 'git') {
    findings.push({ file, line, message: `${what}: the Git evidence command ${JSON.stringify(command)} does not start with git` });
    return undefined;
  }
  try {
    return execFileSync('git', ['-C', root, ...words.slice(1)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    findings.push({ file, line, message: `${what}: \`${command}\` failed in ${root}: ${(error as Error).message}` });
    return undefined;
  }
}

function checkEdges(document: Document, ids: ReadonlySet<string>, findings: Finding[]): void {
  document.edges.forEach((edge, index) => {
    const line = document.edgeLines[index] ?? 1;
    for (const end of ['from', 'to'] as const) {
      const id = edge[end];
      if (typeof id === 'string' && !ids.has(id)) {
        findings.push({ file: document.file, line, message: `the edge ${JSON.stringify(edge.relation ?? '')} names ${JSON.stringify(id)} as its \`${end}\`, and no reference file declares that id` });
      }
    }
  });
}

/** A reference file sits where the file it describes sits: `a/b.go` → `a/b.go.yaml`. */
function checkMirror(document: Document, graphRoot: string, findings: Finding[]): void {
  const fromGraph = relative(graphRoot, document.file).replaceAll('\\', '/');
  const expected = fromGraph.slice(0, -'.yaml'.length);
  if (document.path === undefined) {
    findings.push({ file: document.file, line: 1, message: 'the file has no `path`; it says which repository file it describes' });
    return;
  }
  if (expected === 'repository') {
    if (document.path !== 'repository') findings.push({ file: document.file, line: 1, message: `repository.yaml describes the repository, and its path says ${JSON.stringify(document.path)}` });
    return;
  }
  if (document.path !== expected) {
    findings.push({ file: document.file, line: 1, message: `the file sits at ${fromGraph}, so its path is ${JSON.stringify(expected)}, and it says ${JSON.stringify(document.path)}` });
  }
}

function checkCoverage(graphRoot: string, root: string, findings: Finding[]): void {
  const tracked = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' }).split('\n').filter((line) => line.length > 0);
  for (const path of tracked) {
    const reference = join(graphRoot, `${path}.yaml`);
    if (!existsSync(reference)) findings.push({ file: reference, line: 1, message: `${join(root, path)} is tracked, and has no reference file` });
  }
}

try {
  process.exit(main());
} catch (error) {
  process.exit(usage(error));
}
