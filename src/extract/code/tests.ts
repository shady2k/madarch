/**
 * The test catalogue of a test file: each case by name with the suites that
 * hold it, its kind (unit, table-driven, e2e), whether it is skipped and why.
 * The cases themselves are the symbol reader's (`ExtractedFileSyntax.tests`);
 * this walk reads the call or function each case stands at to say what the
 * reader does not: the `describe` blocks around it, an `it.each` or Go table
 * of inputs and how many rows it holds, `it.skip`/`t.Skip` and the reason the
 * file gives (the first comment inside the skipped case or just before it, or
 * the string passed to `t.Skip`).
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { readSyntaxTree, type ExtractedTest } from '../../fill/stages/syntax-extract.js';
import type { SourceFile } from './source.js';

export type TestKind = 'unit' | 'table-driven' | 'e2e';

export interface TestCaseDetail {
  readonly test: ExtractedTest;
  readonly suite: readonly string[];
  readonly testKind: TestKind;
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly cases?: number;
  /** The byte range of the innermost `describe` that holds the case: its setup and helpers stand there. */
  readonly suiteRange?: { readonly startByte: number; readonly endByte: number };
}

function textOf(node: SyntaxNode, text: string): string {
  return text.slice(node.startIndex, node.endIndex);
}

function named(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child): child is SyntaxNode => child !== null);
}

function stringValue(node: SyntaxNode | null | undefined, text: string): string | undefined {
  if (node === null || node === undefined) return undefined;
  if (node.type === 'string') return textOf(node, text).slice(1, -1);
  if (node.type === 'template_string' && !textOf(node, text).includes('${')) return textOf(node, text).slice(1, -1);
  if (node.type === 'interpreted_string_literal' || node.type === 'raw_string_literal') return textOf(node, text).slice(1, -1);
  return undefined;
}

/** The comment text without its markers. */
function commentText(raw: string): string {
  return raw
    .replace(/^\/\*+|\*+\/$/g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\/\/+|\*+)\s?/, '').trim())
    .filter((line) => line !== '')
    .join(' ');
}

const RUNNERS: ReadonlySet<string> = new Set(['describe', 'fdescribe', 'fit', 'it', 'test', 'xdescribe', 'xit', 'xtest']);

interface Call {
  readonly base: string;
  readonly modifier: string | undefined;
  readonly each: SyntaxNode | undefined;
  readonly name: string | undefined;
  readonly callback: SyntaxNode | undefined;
}

function analyseCall(node: SyntaxNode, text: string): Call | undefined {
  let callee = node.childForFieldName('function');
  const args = node.childForFieldName('arguments');
  if (callee === null || args === null) return undefined;
  let each: SyntaxNode | undefined;
  if (callee.type === 'call_expression') {
    // it.each(table)('name', fn): the table is the inner call's first argument.
    const inner = callee.childForFieldName('function');
    const innerArgs = callee.childForFieldName('arguments');
    if (inner === null || inner.type !== 'member_expression') return undefined;
    const property = inner.childForFieldName('property');
    if (property === null || textOf(property, text) !== 'each') return undefined;
    each = innerArgs === null ? undefined : named(innerArgs)[0];
    callee = inner.childForFieldName('object');
    if (callee === null) return undefined;
  }
  let base: string;
  let modifier: string | undefined;
  if (callee.type === 'identifier') base = textOf(callee, text);
  else if (callee.type === 'member_expression') {
    const object = callee.childForFieldName('object');
    const property = callee.childForFieldName('property');
    if (object === null || property === null || object.type !== 'identifier') return undefined;
    base = textOf(object, text);
    modifier = textOf(property, text);
    if (modifier === 'each') {
      // describe.each(table)(...) written as it.each reaches here only through the inner call above.
      return undefined;
    }
  } else return undefined;
  if (!RUNNERS.has(base)) return undefined;
  const list = named(args);
  const callback = list.find((arg) => ['arrow_function', 'function_expression', 'function'].includes(arg.type));
  return { base, modifier, each, name: stringValue(list[0], text), callback };
}

function isSuite(call: Call): boolean {
  return call.base === 'describe' || call.base === 'fdescribe' || call.base === 'xdescribe';
}

function isSkip(call: Call): boolean {
  return call.modifier === 'skip' || call.base.startsWith('x');
}

function firstComment(node: SyntaxNode): SyntaxNode | undefined {
  if (node.type === 'comment') return node;
  for (const child of node.children) {
    if (child === null) continue;
    const found = firstComment(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

export async function readTestDetails(file: SourceFile, tests: readonly ExtractedTest[]): Promise<ReadonlyMap<number, TestCaseDetail>> {
  const read = await readSyntaxTree(file.path, file.bytes, (parsed) => {
    const text = parsed.text;
    const details = new Map<number, TestCaseDetail>();
    const byStart = new Map<number, ExtractedTest>();
    for (const test of tests) byStart.set(test.span.startByte, test);
    const e2eFile = /(?:^|[./_-])e2e(?:[./_-]|$)/i.test(file.path);

    const visit = (node: SyntaxNode, suite: readonly string[], inLoop: boolean, range?: { startByte: number; endByte: number }, suiteSkipped = false): void => {
      if (file.language === 'go') {
        if (node.type === 'function_declaration') {
          const name = node.childForFieldName('name');
          const written = name === null ? undefined : textOf(name, text);
          const test = byStart.get(node.startIndex) ?? tests.find((candidate) => candidate.name === written);
          if (test !== undefined) details.set(test.span.startByte, goDetail(node, test, text, e2eFile));
        }
        for (const child of named(node)) {
          if (node.type === 'source_file' || node.type === 'function_declaration') visit(child, suite, inLoop);
        }
        return;
      }
      if (node.type === 'call_expression') {
        const call = analyseCall(node, text);
        if (call !== undefined) {
          if (isSuite(call)) {
            const next = call.name === undefined ? suite : [...suite, call.name];
            if (call.callback !== undefined) for (const child of named(call.callback)) visit(child, next, inLoop, { startByte: node.startIndex, endByte: node.endIndex }, suiteSkipped || isSkip(call));
            return;
          }
          const test = byStart.get(node.startIndex) ?? tests.find((candidate) => candidate.name === call.name && candidate.span.startByte >= node.startIndex && candidate.span.endByte <= node.endIndex);
          if (test !== undefined) {
            const skipped = isSkip(call) || suiteSkipped || call.modifier === 'todo';
            const reason = !skipped ? undefined : call.modifier === 'todo' ? 'marked todo' : suiteSkipped && !isSkip(call) ? 'its suite is skipped' : tsSkipReason(node, call, text);
            const rows = call.each !== undefined && call.each.type === 'array' ? named(call.each).length : undefined;
            const table = call.each !== undefined || inLoop;
            details.set(test.span.startByte, {
              test,
              suite,
              testKind: e2eFile || suite.some((name) => /end to end|e2e/i.test(name)) ? 'e2e' : table ? 'table-driven' : 'unit',
              skipped,
              ...(reason === undefined ? {} : { skipReason: reason }),
              ...(rows === undefined ? {} : { cases: rows }),
              ...(range === undefined ? {} : { suiteRange: range }),
            });
            return;
          }
        }
      }
      const loop = inLoop || node.type === 'for_in_statement' || node.type === 'for_statement';
      for (const child of named(node)) visit(child, suite, loop, range, suiteSkipped);
    };
    visit(parsed.root, [], false);
    return details;
  });
  return read.read ? read.value : new Map();
}

function tsSkipReason(node: SyntaxNode, call: Call, text: string): string | undefined {
  if (call.callback !== undefined) {
    const inside = firstComment(call.callback);
    if (inside !== undefined) return commentText(textOf(inside, text));
  }
  const before = node.parent?.type === 'expression_statement' ? node.parent.previousNamedSibling : node.previousNamedSibling;
  if (before !== null && before !== undefined && before.type === 'comment') return commentText(textOf(before, text));
  return undefined;
}

function goDetail(fn: SyntaxNode, test: ExtractedTest, text: string, e2eFile: boolean): TestCaseDetail {
  let rows: number | undefined;
  let skipReason: string | undefined;
  let skipped = false;
  const walk = (node: SyntaxNode): void => {
    if (node.type === 'composite_literal' && rows === undefined) {
      const type = node.childForFieldName('type');
      const element = type !== null && type.type === 'slice_type' ? type.childForFieldName('element') : null;
      if (element !== null && element.type === 'struct_type') {
        const body = node.childForFieldName('body');
        rows = body === null ? 0 : named(body).filter((child) => child.type !== 'comment').length;
      }
    }
    // Only a statement of the test's own body skips it; one inside an `if` or a subtest does not.
    const topLevelStatement = node.parent?.type === 'expression_statement' && node.parent.parent?.parent?.id === fn.id;
    if (node.type === 'call_expression' && !skipped && topLevelStatement) {
      const callee = node.childForFieldName('function');
      if (callee !== null && callee.type === 'selector_expression') {
        const field = callee.childForFieldName('field');
        const written = field === null ? '' : textOf(field, text);
        if (written === 'Skip' || written === 'Skipf' || written === 'SkipNow') {
          skipped = true;
          const args = node.childForFieldName('arguments');
          skipReason = stringValue(args === null ? null : named(args)[0], text);
        }
      }
    }
    for (const child of named(node)) walk(child);
  };
  walk(fn);
  return {
    test,
    suite: [],
    testKind: e2eFile ? 'e2e' : rows !== undefined ? 'table-driven' : 'unit',
    skipped,
    ...(skipReason === undefined ? {} : { skipReason }),
    ...(rows === undefined ? {} : { cases: rows }),
  };
}
