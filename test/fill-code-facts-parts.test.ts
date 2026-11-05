/**
 * The code-facts stage (madarch-8bdc.2.4): one unit per source file, publishing
 * the facts the code readings of operations, contracts and the data model ask
 * of the extract driver's in-memory object — expressions with their literal
 * values, the bindings a declaration makes, the call sites and the Go struct
 * fields — through the graph store's one unit publication.
 *
 * Two files: this one reads the walk's own answer on texts the test writes
 * (nothing else), and the fill acceptance beside it reads what a real run
 * published. The expectations are the fixture's bytes, never the stage's answer.
 */
import { describe, expect, test } from 'bun:test';
import { readSyntaxTree } from '../src/fill/stages/syntax-extract.js';
import { collectFileFacts } from '../src/fill/stages/code-facts.js';

/** One file's facts, walked from its bytes by the same reader the stage runs. */
async function factsOf(path: string, text: string): Promise<ReturnType<typeof collectFileFacts>> {
  const read = await readSyntaxTree(path, new TextEncoder().encode(text), (tree) =>
    collectFileFacts('shop', path, tree.text, tree.root, tree.language));
  if (!read.read) throw new Error(`the fixture ${path} was not parsed: ${JSON.stringify(read.unread)}`);
  return read.value;
}

/** The one fact a predicate names, refused where the walk found none or several. */
function one<T>(items: readonly T[], what: string, predicate: (item: T) => boolean): T {
  const found = items.filter(predicate);
  if (found.length !== 1) throw new Error(`the walk holds ${String(found.length)} ${what}, and this test needs exactly one`);
  return found[0]!;
}

describe('one file\'s code facts', () => {
  test('reads the literal values, the bindings and the calls a TypeScript file writes', async () => {
    const path = 'services/orders/src/config.ts';
    const text = [
      'export const port = Number(process.env.PORT ?? "8080");',
      'export const label = prefix("orders");',
      'export const slug = `svc-${label}`;',
      'function prefix(name: string): string { return name; }',
      '',
    ].join('\n');
    const facts = await factsOf(path, text);
    // Every named node is an expression with its place; a comment and a blank line are not.
    expect(facts.expressions.length).toBeGreaterThan(20);
    expect(facts.expressions.every((expression) => expression.id.includes(`:${path}@`))).toBe(true);
    // A string literal holds its raw token and the value it decodes to.
    const literal = one(facts.expressions, 'string literal', (expression) => expression.literal?.value === '8080');
    expect(literal.syntaxKind).toBe('string');
    expect(literal.literal).toEqual({ kind: 'string', raw: '"8080"', value: '8080' });
    expect(literal.span.lineStart).toBe(1);
    // A binding is the name a declaration makes, with the initializer the declaration writes.
    const port = one(facts.bindings, 'binding named port', (binding) => binding.name === 'port');
    expect(port.kind).toBe('local');
    expect(port.initializer).toBeDefined();
    const initializer = facts.expressions.find((expression) => expression.id === port.initializer);
    expect(initializer?.syntaxKind).toBe('call_expression');
    expect(initializer?.callee).toBeDefined();
    const parameter = one(facts.bindings, 'parameter named name', (binding) => binding.name === 'name');
    expect(parameter.kind).toBe('parameter');
    // A call site names its callee and its arguments, both as the expressions the walk holds.
    const call = one(facts.calls, 'call of prefix', (entry) => {
      const callee = facts.expressions.find((expression) => expression.id === entry.callee);
      return callee?.name === 'prefix' || callee?.member === 'prefix';
    });
    expect(call.arguments.length).toBe(1);
    const argument = facts.expressions.find((expression) => expression.id === call.arguments[0]);
    expect(argument?.literal).toEqual({ kind: 'string', raw: '"orders"', value: 'orders' });
    // A template with an interpolation holds code, not one value: its raw text stands and no value is claimed.
    const template = one(facts.expressions, 'template with an interpolation', (expression) => expression.syntaxKind === 'template_string' && (expression.literal?.raw.includes('${') ?? false));
    expect(template.literal?.value).toBeUndefined();
  }, 60_000);

  test('reads a Go struct field and an interpreted string literal', async () => {
    const path = 'services/orders/internal/domain/order.go';
    const text = [
      'package domain',
      '',
      'type Order struct {',
      '\tStatus Status',
      '}',
      '',
      'const Pending Status = "pending"',
      '',
      'func label(n string) string { return `svc-${n}` }',
      '',
    ].join('\n');
    const facts = await factsOf(path, text);
    const field = one(facts.fields, 'struct field', (entry) => entry.name === 'Status');
    expect(field.ownerTypeName).toBe('Order');
    expect(field.typeExpression).toBeDefined();
    const literal = one(facts.expressions, 'Go string literal', (expression) => expression.literal?.value === 'pending');
    expect(literal.literal).toEqual({ kind: 'string', raw: '"pending"', value: 'pending' });
    // A Go raw string keeps its raw token and holds its body as the value it is.
    const raw = one(facts.expressions, 'Go raw string', (expression) => expression.syntaxKind === 'raw_string_literal');
    expect(raw.literal?.value).toBe(raw.literal?.raw.slice(1, -1));
  }, 60_000);
});
