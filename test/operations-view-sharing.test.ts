/**
 * One operations fact view per tree (madarch-mwhd.3): a tree answers the same
 * view to every extractor handed its reader and never answers it to another
 * tree, a second pass over that view builds none of its indexes, text or
 * library evaluation again, and each pass keeps the gaps it proved itself, so
 * the records both extractors publish are the ones they published alone.
 */
import {expect, test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import {extractOperations} from '../src/extract/operations/index.js';
import {releaseTreeView, treeView} from '../src/extract/operations/source.js';
import {byCodePoint} from '../src/model/order.js';
import type {Extraction, TreeReader} from '../src/extract/records.js';

const MAIN = 'services/api/main.ts';
const CONTRACT = 'contracts/openapi/api.yaml';

/** The route of a small service: one Express registration, one listener. */
const route = `import express from "express";
function health(req:any,res:any){res.send("ok");}
export function setup(){const app=express();app.get("/healthz",health);`;

/** A contract whose only server is outside this tree, so the run proves a gap. */
const contract = `openapi: 3.0.0
info: {title: API, version: 1.0.0}
servers: [{url: "https://outside.example"}]
paths:
 /healthz:
  get: {operationId: health}
`;

interface Fixture {
  readonly reader: TreeReader;
  /** Every path the reader was asked to read, in the order it was asked. */
  readonly reads: readonly string[];
}

/** One in-memory tree of that service, and the paths its readers read from it. */
function fixture(): Fixture {
  const files: Readonly<Record<string, string>> = {[MAIN]: `${route}app.listen(8080);}`, [CONTRACT]: contract};
  const reads: string[] = [];
  const reader: TreeReader = {
    paths: Object.keys(files).sort(byCodePoint),
    read(path: string): Uint8Array {
      const source = files[path];
      if (source === undefined) throw new Error(`${import.meta.path}: the fixture tree holds no ${path}`);
      reads.push(path);
      return new TextEncoder().encode(source);
    },
  };
  return {reader, reads};
}

/** One extraction's records as sorted JSON: the nodes, the edges and the gaps, with their spans. */
function comparable(extraction: Extraction): string {
  const nodes = [...extraction.nodes].sort((left, right) => byCodePoint(left.key, right.key));
  const edges = [...extraction.edges].sort((left, right) => byCodePoint(
    `${left.type}\u0000${left.from}\u0000${left.to}\u0000${left.discriminator}`,
    `${right.type}\u0000${right.from}\u0000${right.to}\u0000${right.discriminator}`,
  ));
  const gaps = [...extraction.gaps].sort((left, right) => byCodePoint(
    `${left.path}\u0000${left.reason}`,
    `${right.path}\u0000${right.reason}`,
  ));
  return JSON.stringify({nodes, edges, gaps});
}

test('one tree answers one view, and another tree answers its own', async () => {
  const first = fixture();
  const firstCode = await extractCodeWithFacts(first.reader);
  const view = treeView(first.reader, firstCode.extraction, firstCode.facts);
  expect(treeView(first.reader, firstCode.extraction, firstCode.facts)).toBe(view);
  expect(view.facts).toBe(firstCode.facts);
  const second = fixture();
  const secondCode = await extractCodeWithFacts(second.reader);
  expect(treeView(second.reader, secondCode.extraction, secondCode.facts)).not.toBe(view);
});

test('a second pass over one view builds none of its indexes, text or library evaluation', async () => {
  const {reader, reads} = fixture();
  const code = await extractCodeWithFacts(reader);
  const view = treeView(reader, code.extraction, code.facts);
  const first = view.pass();
  const second = view.pass();
  expect(first).not.toBe(second);
  expect(first.facts).toBe(view.facts);
  expect(second.facts).toBe(view.facts);
  expect(second.expressionsByPath).toBe(view.expressionsByPath);
  expect(second.symbolsByKey).toBe(view.symbolsByKey);
  expect(second.filesByPath).toBe(view.filesByPath);
  const text = first.text(MAIN);
  const boundaries = first.charBoundaries(MAIN);
  const evaluation = view.libraryFacts();
  expect(evaluation).toBeDefined();
  const asked = reads.length;
  expect(second.text(MAIN)).toBe(text);
  expect(second.charBoundaries(MAIN)).toBe(boundaries);
  expect(second.libraryFacts()).toBe(evaluation);
  expect(reads.slice(asked)).toEqual([]);
});

test('a contracts run over the shared view is byte-identical to one that builds its own', async () => {
  const shared = fixture();
  const sharedCode = await extractCodeWithFacts(shared.reader);
  // The driver reads one commit's tree in this order: the operations extractor
  // makes the tree's view and the contracts extractor reads it after.
  const operations = await extractOperations(shared.reader, sharedCode.extraction, sharedCode.facts);
  const view = treeView(shared.reader, sharedCode.extraction, sharedCode.facts);
  const overView = await extractContracts(shared.reader, sharedCode.extraction, sharedCode.facts);
  expect(treeView(shared.reader, sharedCode.extraction, sharedCode.facts)).toBe(view);
  const own = fixture();
  const ownCode = await extractCodeWithFacts(own.reader);
  const ownView = await extractContracts(own.reader, ownCode.extraction, ownCode.facts);
  expect(comparable(overView)).toBe(comparable(ownView));
  // Two empty extractions would compare equal and prove nothing.
  expect(operations.nodes.length).toBeGreaterThan(0);
  expect(overView.nodes.length).toBeGreaterThan(0);
  expect(overView.edges.length).toBeGreaterThan(0);
  expect(overView.gaps.length).toBeGreaterThan(0);
});

test('a gap one pass records is not reported by another pass over the same view', async () => {
  const {reader} = fixture();
  const code = await extractCodeWithFacts(reader);
  const view = treeView(reader, code.extraction, code.facts);
  const first = view.pass();
  const second = view.pass();
  const gap = {path: MAIN, reason: 'line 4: the pass could not read this route'};
  first.factGap(gap.path, gap.reason);
  first.factGap(gap.path, gap.reason);
  expect([...first.factGaps.values()]).toEqual([gap]);
  expect([...second.factGaps.values()]).toEqual([]);
  expect([...view.factGaps.values()]).toEqual([]);
});

test('a released view is answered to its reader no more, and another reader never answers it', async () => {
  const released = fixture();
  const releasedCode = await extractCodeWithFacts(released.reader);
  const view = treeView(released.reader, releasedCode.extraction, releasedCode.facts);
  const other = fixture();
  const otherCode = await extractCodeWithFacts(other.reader);
  expect(treeView(other.reader, otherCode.extraction, otherCode.facts)).not.toBe(view);
  releaseTreeView(released.reader);
  const rebuilt = treeView(released.reader, releasedCode.extraction, releasedCode.facts);
  expect(rebuilt).not.toBe(view);
  expect(rebuilt.facts).toBe(releasedCode.facts);
});

test('a question that brings another extraction or another fact set builds its own view', async () => {
  const {reader} = fixture();
  const code = await extractCodeWithFacts(reader);
  const view = treeView(reader, code.extraction, code.facts);
  expect(treeView(reader, code.extraction)).not.toBe(view);
  expect(treeView(reader, {...code.extraction}, code.facts)).not.toBe(view);
});
