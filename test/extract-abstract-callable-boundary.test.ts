import { expect, test } from 'bun:test';
import type { CodeFacts } from '../src/extract/code/facts.js';
import { extractCodeWithFacts } from '../src/extract/code/index.js';
import { TreeText } from '../src/extract/operations/source.js';
import { functionAt, functionsOf } from '../src/extract/operations/symbol-sites.js';
import type { TreeReader } from '../src/extract/records.js';

const source = [
  'export abstract class BaseProvider {',
  '  protected abstract submit(value: string): string;',
  '  protected abstract submitRefund(value: string): string;',
  '  actual(): number { /* abstract is not a signature proof */ return 1; }',
  '}',
].join('\n');

function treeOf(path: string): TreeReader {
  return { paths: [path], read: (requested) => {
    if (requested !== path) throw new Error(`missing fixture path ${requested}`);
    return new TextEncoder().encode(source);
  } };
}

test('protected abstract methods are declaration-only while a concrete class method remains executable', async () => {
  for (const path of ['lib/provider.ts', 'lib/provider.tsx']) {
    const tree = treeOf(path);
    const code = await extractCodeWithFacts(tree);
    const signatures = code.facts.symbols.filter((symbol) => ['submit', 'submitRefund'].includes(symbol.name));
    expect(signatures).toHaveLength(2);
    expect(signatures.every((symbol) => symbol.callable && symbol.symbolKind === 'method' &&
      symbol.bodySpan === undefined && symbol.bodySyntaxKind === undefined)).toBe(true);
    expect(code.facts.expressions.filter((entry) => entry.syntaxKind === 'abstract_method_signature')).toHaveLength(2);
    expect(code.facts.expressions.filter((entry) => entry.syntaxKind === 'abstract_class_declaration')).toHaveLength(1);
    const context = new TreeText(tree, code.extraction, code.facts);
    const sites = functionsOf(context, path);
    expect(sites.map((site) => site.qualifiedName)).toEqual(['BaseProvider.actual']);
    expect(functionAt(context, path, source.indexOf('return 1'))?.key).toBe(sites[0]?.key);
    expect([...context.factGaps.values()]).toEqual([]);
  }
});

test('abstract signatures need unique copied signature, name, container and canonical abstract-class proof', async () => {
  const path = 'lib/provider.ts';
  const tree = treeOf(path);
  const code = await extractCodeWithFacts(tree);
  const facts = code.facts;
  const signature = facts.symbols.find((entry) => entry.name === 'submit')!;
  const method = facts.expressions.find((entry) => entry.syntaxKind === 'abstract_method_signature' &&
    entry.span.byteStart === signature.span.byteStart)!;
  const nameId = method.fields.name![0]!;
  const name = facts.expressions.find((entry) => entry.id === nameId)!;
  const container = facts.expressions.find((entry) => entry.syntaxKind === 'class_body')!;
  const owner = facts.expressions.find((entry) => entry.syntaxKind === 'abstract_class_declaration')!;
  const canonical = facts.symbols.find((entry) => entry.symbolKind === 'class')!;
  expect(signature).toBeDefined();
  expect(method).toBeDefined();
  expect(name).toBeDefined();
  expect(container).toBeDefined();
  expect(owner).toBeDefined();
  expect(canonical).toBeDefined();
  const changed = (id: string, replacement: Partial<(typeof facts.expressions)[number]>): CodeFacts => ({
    ...facts, expressions: facts.expressions.map((entry) => entry.id === id ? { ...entry, ...replacement } : entry),
  });
  const variants: readonly (readonly [string, CodeFacts])[] = [
    ['missing signature', { ...facts, expressions: facts.expressions.filter((entry) => entry.id !== method.id) }],
    ['duplicate signature', { ...facts, expressions: [...facts.expressions, method] }],
    ['concrete signature kind', changed(method.id, { syntaxKind: 'method_definition' })],
    ['mismatched signature span', changed(method.id, { span: { ...method.span, byteEnd: method.span.byteEnd - 1 } })],
    ['signature body field', changed(method.id, { fields: { ...method.fields, body: [container.id] } })],
    ['missing name', { ...facts, expressions: facts.expressions.filter((entry) => entry.id !== nameId) }],
    ['duplicate name', { ...facts, expressions: [...facts.expressions, name] }],
    ['wrong name', changed(nameId, { name: 'other' })],
    ['repeated name field', changed(method.id, { fields: { ...method.fields, name: [nameId, nameId] } })],
    ['missing name child', changed(method.id, { children: method.children.filter((id) => id !== nameId) })],
    ['missing class body', { ...facts, expressions: facts.expressions.filter((entry) => entry.id !== container.id) }],
    ['missing signature child', changed(container.id, { children: container.children.filter((id) => id !== method.id) })],
    ['wrong class body span', changed(container.id, { span: { ...container.span, byteStart: method.span.byteEnd } })],
    ['missing abstract class', { ...facts, expressions: facts.expressions.filter((entry) => entry.id !== owner.id) }],
    ['concrete class kind', changed(owner.id, { syntaxKind: 'class_declaration' })],
    ['missing class body field', changed(owner.id, { fields: { ...owner.fields, body: [] } })],
    ['missing canonical class', { ...facts, symbols: facts.symbols.filter((entry) => entry.key !== canonical.key) }],
    ['duplicate canonical class', { ...facts, symbols: [...facts.symbols, canonical] }],
    ['wrong canonical class name', { ...facts, symbols: facts.symbols.map((entry) => entry.key === canonical.key ? { ...entry, name: 'Other' } : entry) }],
    ['wrong canonical class span', { ...facts, symbols: facts.symbols.map((entry) => entry.key === canonical.key
      ? { ...entry, span: { ...entry.span, byteEnd: entry.span.byteEnd - 1 } } : entry) }],
    ['wrong qualified owner', { ...facts, symbols: facts.symbols.map((entry) => entry.key === signature.key
      ? { ...entry, qualifiedName: 'Other.submit' } : entry) }],
    ['duplicate callable', { ...facts, symbols: [...facts.symbols, signature] }],
  ];
  for (const [label, invalidFacts] of variants) {
    const context = new TreeText(tree, code.extraction, invalidFacts);
    const sites = functionsOf(context, path);
    expect(sites.map((site) => site.qualifiedName), label).toEqual(['BaseProvider.actual']);
    expect([...context.factGaps.values()].some((gap) => gap.path === path && gap.reason.includes(signature.key) &&
      (gap.reason.includes('has no proved body') || gap.reason.includes('duplicate callable identity'))), label).toBe(true);
  }
});

test('removed concrete body metadata stays a tombstone even inside a proved abstract class', async () => {
  const path = 'lib/provider.ts';
  const tree = treeOf(path);
  const code = await extractCodeWithFacts(tree);
  const concrete = code.facts.symbols.find((entry) => entry.name === 'actual')!;
  expect(concrete.bodySpan).toBeDefined();
  expect(concrete.bodySyntaxKind).toBeDefined();
  for (const removed of [
    { bodySpan: undefined },
    { bodySyntaxKind: undefined },
    { bodySpan: undefined, bodySyntaxKind: undefined },
  ]) {
    const facts: CodeFacts = { ...code.facts, symbols: code.facts.symbols.map((entry) => entry.key === concrete.key
      ? { ...entry, ...removed } : entry) };
    const context = new TreeText(tree, code.extraction, facts);
    expect(functionsOf(context, path)).toEqual([]);
    expect(functionAt(context, path, source.indexOf('return 1'))).toBeUndefined();
    expect([...context.factGaps.values()].some((gap) => gap.path === path &&
      gap.reason.includes(`callable ${concrete.key} has no proved body`))).toBe(true);
  }
});
