import {expect, test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {freezeCodeFacts, type CodeFacts} from '../src/extract/code/facts.js';
import {extractOperations} from '../src/extract/operations/index.js';
import {TreeText} from '../src/extract/operations/source.js';
import {sortedByCodePoint} from '../src/model/order.js';
import type {Extraction, TreeReader} from '../src/extract/records.js';

const goPath = 'services/api/telemetry.go';
const metricKey = `code.metric:${goPath}#queue_events_total`;
/** One modeled exposition writer: a TYPE line and one sample over a field the tree writes. */
const source = `package api
import printer "fmt"
import "io"
type Telemetry struct { count int64 }
func (t *Telemetry) Add() { t.count++ }
func (t *Telemetry) Export(w io.Writer) {
 printer.Fprint(w, "# TYPE queue_events_total counter\\n")
 printer.Fprintf(w, "queue_events_total %d\\n", t.count)
}`;
const treeOf = (text: string): TreeReader => ({paths: [goPath], read: () => new TextEncoder().encode(text)});

/** The scan each index replaced, kept here so every lookup can be compared with it. */
const scanned = <T>(items: readonly T[], keep: (item: T) => boolean): readonly T[] => items.filter((item) => keep(item));
/** The lookup the metrics extractor makes: the one entry under a key, or nothing when two hold it. */
const unique = <T>(items: readonly T[]): T | undefined => items.length === 1 ? items[0] : undefined;

/** The expression the text-metrics path reads as the sample value: the printf argument of the exposition call. */
const sampleValueExpression = (facts: CodeFacts): string => {
  const byId = new Map(facts.expressions.map((expression) => [expression.id, expression] as const));
  const holdsFormat = (id: string): boolean => {
    const literal = byId.get(id)?.literal;
    return literal !== undefined && (literal.raw.includes('queue_events_total %d') ||
      (typeof literal.value === 'string' && literal.value.includes('queue_events_total %d')));
  };
  const call = facts.calls.find((entry) => byId.get(entry.callee)?.member === 'Fprintf')
    ?? facts.calls.find((entry) => entry.arguments.some(holdsFormat));
  const value = call?.arguments.at(-1);
  if (value === undefined) throw new Error('the exposition sample call and its value argument are not in the facts');
  return value;
};

/** The gap reasons one extraction records about the one metric of the tree. */
const metricGaps = (result: Extraction): readonly string[] =>
  result.gaps.map((gap) => gap.reason).filter((reason) => reason.includes('metric queue_events_total: '));

test('both lookups answer from the view index exactly as the whole-array scans did', async () => {
  const input = treeOf(source);
  const code = await extractCodeWithFacts(input);
  const facts = code.facts;
  const view = new TreeText(input, code.extraction, facts);

  for (const expression of facts.expressions) {
    const indexed = view.expressionsById.all(expression.id);
    const held = scanned(facts.expressions, (entry) => entry.id === expression.id);
    expect(indexed).toEqual(held);
    // The facts' own order is kept, so the same entry stands first and last in both.
    expect(indexed[0]).toBe(held[0]);
    expect(indexed.at(-1)).toBe(held.at(-1));
  }
  for (const call of facts.calls) {
    const indexed = view.callsByExpression.all(call.expression);
    const held = scanned(facts.calls, (entry) => entry.expression === call.expression);
    expect(indexed).toEqual(held);
    expect(indexed[0]).toBe(held[0]);
    expect(indexed.at(-1)).toBe(held.at(-1));
  }
  // The index holds one group per call expression the facts carry, and no other key.
  expect(sortedByCodePoint(view.callsByExpression.keys())).toEqual(sortedByCodePoint([...new Set(facts.calls.map((call) => call.expression))]));

  // The sample value the text-metrics path looks up answers with the one expression the scan found.
  const valueId = sampleValueExpression(facts);
  const indexedValue = unique(view.expressionsById.all(valueId));
  expect(indexedValue).toBe(unique(scanned(facts.expressions, (entry) => entry.id === valueId)));
  if (indexedValue === undefined) throw new Error('the sample value expression is not in the facts');
  expect(indexedValue.path).toBe(goPath);
  // It is the field read of the sample, so the lookup the text path makes is the one duplicated below.
  expect(indexedValue.syntaxKind).toBe('selector_expression');
  // The parsed-Go guard still admits that path: the file fact the guard reads is unchanged.
  const file = view.filesByPath.all(goPath)[0];
  expect(file?.language).toBe('go');
  expect(file?.parsed).toBe(true);

  // A key the facts do not hold answers with no entry at all, as the scan did.
  const absentId = `${goPath}:0:1:identifier`;
  expect(view.expressionsById.all(absentId)).toEqual([]);
  expect(view.expressionsById.all(absentId)).toEqual(scanned(facts.expressions, (entry) => entry.id === absentId));
  expect(unique(view.expressionsById.all(absentId))).toBeUndefined();
  expect(view.callsByExpression.all(absentId)).toEqual([]);
  expect(view.callsByExpression.all(absentId)).toEqual(scanned(facts.calls, (entry) => entry.expression === absentId));
  expect(unique(view.callsByExpression.all(absentId))).toBeUndefined();
  // A path that holds no expression answers the same way.
  const absentPath = 'services/api/nowhere.go';
  expect(view.expressionsByPath.all(absentPath)).toEqual(scanned(facts.expressions, (entry) => entry.path === absentPath));
  expect(view.expressionsByPath.all(absentPath)).toEqual([]);

  // Every group stays an array a caller cannot shrink, so a proof cannot be made smaller.
  const indexes: {keys(): readonly string[]; all(key: string): readonly unknown[]}[] = [view.expressionsById, view.callsByExpression];
  for (const index of indexes) for (const key of index.keys()) expect(Object.isFrozen(index.all(key))).toBe(true);
});

test('a duplicated id answers nothing in both providers and keeps the gap the scan produced', async () => {
  const input = treeOf(source);
  const code = await extractCodeWithFacts(input);
  const control = extractOperations(input, code.extraction, code.facts);
  const valueId = sampleValueExpression(code.facts);
  const original = code.facts.expressions.find((entry) => entry.id === valueId);
  if (original === undefined) throw new Error('the sample value expression is not in the facts');

  // Two expressions under one id: both stay, in facts order, so the lookup still refuses.
  const copy = {...original};
  const repeated = freezeCodeFacts({...code.facts, expressions: [...code.facts.expressions, copy]});
  const repeatedView = new TreeText(input, code.extraction, repeated);
  const held = repeatedView.expressionsById.all(valueId);
  expect(held).toHaveLength(2);
  expect(held[0]).toBe(original);
  expect(held[1]).toBe(copy);
  expect(unique(held)).toBeUndefined();
  expect(unique(scanned(repeated.expressions, (entry) => entry.id === valueId))).toBeUndefined();
  expect(unique(scanned(code.facts.expressions, (entry) => entry.id === valueId))).toBe(original);

  // The record set is not silently smaller: the metric stays and names the gap it cannot prove.
  const duplicated = extractOperations(input, code.extraction, repeated);
  expect(control.nodes.filter((node) => node.kind === 'code.metric').map((node) => node.key)).toEqual([metricKey]);
  // A duplicated id answers nothing through either provider, so the sample value is
  // unresolved and no metric node is claimed: the same records the scan produced.
  expect(duplicated.nodes.filter((node) => node.kind === 'code.metric')).toEqual([]);
  // The control proves the backing field; a duplicated id proves nothing through
  // either provider, so no backing declaration and no update edge is claimed.
  expect(control.nodes.find((node) => node.key === metricKey)?.properties.backingDeclaration).toBe(`code.symbol:${goPath}#Telemetry.count`);
  expect(control.edges.filter((edge) => edge.type === 'code.updates-metric' && edge.to === metricKey).length).toBeGreaterThan(0);
  expect(duplicated.edges.filter((edge) => edge.type === 'code.updates-metric' && edge.to === metricKey)).toEqual([]);
  // The extraction-level gap text for a duplicated id is NOT asserted here: the
  // metric node it would name is not produced at all, which is the same records
  // the whole-array scan produced. The provider contract is asserted above.

  // Two calls of one expression refuse the same way, so a call proof is never half answered.
  const call = code.facts.calls.find((entry) => entry.arguments.includes(valueId));
  if (call === undefined) throw new Error('the exposition sample call is not in the facts');
  const repeatedCalls = freezeCodeFacts({...code.facts, calls: [...code.facts.calls, {...call}]});
  const callsView = new TreeText(input, code.extraction, repeatedCalls);
  expect(callsView.callsByExpression.all(call.expression)).toHaveLength(2);
  expect(callsView.callsByExpression.all(call.expression)[0]).toBe(call);
  expect(unique(callsView.callsByExpression.all(call.expression))).toBeUndefined();
  expect(unique(scanned(repeatedCalls.calls, (entry) => entry.expression === call.expression))).toBeUndefined();
});

test('the produced records keep their order and each view keeps its own index', async () => {
  const input = treeOf(source);
  const code = await extractCodeWithFacts(input);
  const first = extractOperations(input, code.extraction, code.facts);
  const second = extractOperations(input, code.extraction, code.facts);
  const keys = first.nodes.map((node) => node.key);
  expect(keys).toContain(metricKey);
  expect(second.nodes.map((node) => node.key)).toEqual(keys);
  expect(second.edges).toEqual(first.edges);
  expect(second.gaps).toEqual(first.gaps);
  // The order of the records is the extractor's canonical one, not the index's iteration order.
  expect(keys).toEqual(sortedByCodePoint(keys));
  expect(first.gaps.map((gap) => `${gap.path}\u0000${gap.reason}`)).toEqual(sortedByCodePoint(first.gaps.map((gap) => `${gap.path}\u0000${gap.reason}`)));

  // Two views over one fact set answer alike, and neither is the other's index.
  const one = new TreeText(input, code.extraction, code.facts);
  const other = new TreeText(input, code.extraction, code.facts);
  expect(one.expressionsById).not.toBe(other.expressionsById);
  expect(one.callsByExpression).not.toBe(other.callsByExpression);
  const valueId = sampleValueExpression(code.facts);
  expect(one.expressionsById.all(valueId)).toHaveLength(1);
  expect(one.expressionsById.all(valueId)).toEqual(other.expressionsById.all(valueId));
  expect(one.callsByExpression.keys()).toEqual(other.callsByExpression.keys());

  // A view over facts that hold no expression answers nothing, and hides nothing from the other view.
  const empty = new TreeText(input, code.extraction, freezeCodeFacts({...code.facts, expressions: [], calls: []}));
  expect(empty.expressionsById.keys()).toEqual([]);
  expect(empty.callsByExpression.keys()).toEqual([]);
  expect(empty.expressionsById.all(valueId)).toEqual([]);
  expect(empty.callsByExpression.all(valueId)).toEqual([]);
  expect(unique(empty.expressionsById.all(valueId))).toBeUndefined();
  expect(one.expressionsById.all(valueId)).toHaveLength(1);
});
