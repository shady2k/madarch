/**
 * The source-text guard of madarch-mwhd.3 over `src/extract` (product-wiki/no-source-patterns:
 * parser-source-guard and parser-guard-counterexamples).
 *
 * What it refuses. A reader under `src/extract` decides what a repository says from the parser's
 * facts. Two shapes break that rule, and both are refused here:
 *
 *  - a RegExp — a literal, `new RegExp(...)`, or a variable that holds one — applied with
 *    `.test(`/`.exec(` to a syntax node's own `.text`, or to a value that holds one;
 *  - `.includes(`, `.indexOf(` or `.lastIndexOf(` asked of a syntax node's `.text`, or of a value
 *    that holds one.
 *
 * The decision comes from node shapes, never from a second pattern over the source. A file is read
 * as bytes only to be parsed by `readSyntaxTree`, the project's own tree-sitter boundary, and every
 * question below is asked of `call_expression`, `member_expression`, `variable_declarator`,
 * `ternary_expression`, `binary_expression` and the field names `function`, `object`, `property`,
 * `arguments` and `value`.
 *
 * What it allows, and why. Read this list before arguing with a finding:
 *
 *  - `node.type`, field names, `node.id` and spans: parser facts, not the file's characters.
 *  - a node's `.text` handed on — into a fact (`handler.text`), a span, a diagnostic or an error
 *    message (`node.text.slice(0, 60)`, `'unreadable ' + node.text`). The characters leave the
 *    reader; nothing decides by matching them. This guard's own `Finding.construct` is that use:
 *    it is printed for a person and compared with nothing.
 *  - a literal's decoded value (`stringValue(node)`): the grammar delimited the token, and the
 *    value is the grammar's answer.
 *  - a whole file's text from `TreeText` (`t.text(path)`): not a syntax node, so out of this
 *    rule's scope. Those readers are the wider owner rule's debt and the change's migration
 *    inventory lists them; this guard neither calls them clean nor lets them hide a node-text
 *    finding, and it must not be read as the complete no-regex guard of the change.
 *  - a reader helper that only copies a node's text (`textOf(node, text)` in `code/`): the same
 *    copying use as the second item, though its callers still have to keep this rule.
 *
 * What it does not reach, said plainly so nobody reads the silence as a licence. The rule follows
 * a name through annotated parameters (`: SyntaxNode`, `: Node`), the callback of the project's
 * `walkTree`, variable declarations and node-list elements. A node that arrives as an unannotated
 * helper parameter or a `for (const child of ...)` binding is not followed, and neither is text a
 * helper hands back (`textOf(node, text)`): searching that text from a caller stays a breach of
 * the owner's rule, and one this shape-level guard cannot see. Loosen neither to hide a finding.
 *
 * Where the migration stands. Four files under `src/extract` hold nine refusals today —
 * `contracts/go-code.ts` (four), `contracts/ts-code.ts` (three), `contracts/walk.ts` (one) and
 * `shell-command.ts` (one) — and `PRESENT_DEBT` names them by file and kind. The tree case
 * asserts that list exactly, so a new source-text parse anywhere under `src/extract` turns this
 * test red, and a fixed one turns it red until its entry leaves the list. That keeps the list
 * honest and shrinking to `[]`: the zero-finding, blocking form the change requires at
 * acceptance. The shape the go-code reader held at lines 318-320 (a regex `exec` over
 * `?.childForFieldName('operand')?.text`) was refactored away before this guard landed, so the
 * fixture below carries it: the same checker refuses it, and refuses `statement.text.includes`,
 * a variable that holds a `.text`, and a pattern kept in a variable.
 *
 * The counts are a snapshot of one tree. `src/extract` is being migrated while this guard lands,
 * so a reader who finds the list out of date should take the list the failure message prints,
 * reconcile it here, and never add an entry to silence a finding that can simply be removed.
 */
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'bun:test';
import type {Node as SyntaxNode} from 'web-tree-sitter';
import {byCodePoint} from '../src/model/order.js';
import {readSyntaxTree, syntaxLanguageOf, type ParsedSyntaxTree} from '../src/fill/stages/syntax-extract.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARDED = 'src/extract';

/** The shape a finding names, so a migration can count what it fixed. */
type FindingKind = 'regex-test' | 'regex-exec' | 'regex-apply' | 'text-search';

interface Finding {
  /** The repository-relative path of the file the construct stands in. */
  readonly file: string;
  /** The 1-based line the construct starts on. */
  readonly line: number;
  /** The 1-based column the construct starts at. */
  readonly column: number;
  readonly kind: FindingKind;
  /** The construct as a person reads it. Printed, never matched: no decision uses these characters. */
  readonly construct: string;
}

/** What a name in one file holds, as far as this rule needs to know. */
interface Names {
  /** The names that hold a syntax node. */
  readonly nodes: Set<string>;
  /** The names that hold a syntax node's own text. */
  readonly texts: Set<string>;
  /** The names that hold a RegExp. */
  readonly patterns: Set<string>;
}

/** The property whose read is a syntax node's own source text. */
const SOURCE_TEXT = 'text';

/** The tree-sitter reads that answer a node, so a `.text` on one is that node's own text. */
const NODE_ACCESSORS: ReadonlySet<string> = new Set([
  'child', 'childForFieldName', 'childrenForFieldName', 'descendantForByteRange', 'descendantForIndex',
  'descendantForPointRange', 'firstChild', 'firstNamedChild', 'lastChild', 'lastNamedChild', 'namedChild',
  'namedChildren', 'nextNamedSibling', 'nextSibling', 'previousNamedSibling', 'previousSibling',
]);

/** The node properties that answer another node. */
const NODE_PROPERTIES: ReadonlySet<string> = new Set(['parent', 'rootNode']);

/** The string reads that answer text, so a chain through them still holds a node's text. */
const TEXT_ANSWERS: ReadonlySet<string> = new Set([
  'at', 'charAt', 'concat', 'normalize', 'padEnd', 'padStart', 'repeat', 'replace', 'slice', 'substring',
  'toLowerCase', 'toUpperCase', 'trim', 'trimEnd', 'trimStart',
]);

/** The questions this rule refuses to ask of a node's text. */
const TEXT_SEARCHES: ReadonlySet<string> = new Set(['includes', 'indexOf', 'lastIndexOf']);

/**
 * Every method that applies a pattern to the string it is called on: a file's whole text or a
 * node's own text is repository text, and no reader may decide anything by matching a pattern to it.
 */
const REGEX_APPLICATIONS: ReadonlySet<string> = new Set(['match', 'matchAll', 'replace', 'replaceAll', 'search', 'split']);

/**
 * The reads that answer repository text: a `TreeText`'s whole file or its lines, a tree's bytes,
 * the shared reader's text, and a decoder's answer. A value that holds one of these holds
 * repository text, whatever the reader calls the variable.
 */
const REPOSITORY_TEXT_READS: ReadonlySet<string> = new Set(['text', 'lines', 'read', 'readUtf8', 'readFileSync', 'decode']);

/** The array reads whose callback receives the elements of the list: of a text list, each element is text. */
const TEXT_LISTS: ReadonlySet<string> = new Set(['filter', 'find', 'findIndex', 'flatMap', 'forEach', 'map', 'some', 'every']);

/** The node types the project's code names a syntax node with, in a parameter annotation. */
const NODE_TYPE_NAMES: ReadonlySet<string> = new Set(['Node', 'SyntaxNode']);

/** The named children of a node, without the nulls `web-tree-sitter` types into the list. */
function named(node: SyntaxNode | null): readonly SyntaxNode[] {
  if (node === null) return [];
  const children: SyntaxNode[] = [];
  for (const child of node.namedChildren) if (child !== null) children.push(child);
  return children;
}

/** Visits a node and every node below it, pre-order. */
function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of named(node)) walk(child, visit);
}

/** The expression a member reads off (`a.b` and `a?.b` both answer `a`). */
function objectOf(member: SyntaxNode): SyntaxNode | null {
  const field = member.childForFieldName('object');
  if (field !== null) return field;
  for (const child of named(member)) {
    if (child.type === 'property_identifier' || child.type === 'private_property_identifier' || child.type === 'optional_chain') continue;
    return child;
  }
  return null;
}

/** The name a member's property writes (`text` of `node.text`), when it is a plain name. */
function propertyOf(member: SyntaxNode): string | undefined {
  const field = member.childForFieldName('property');
  if (field !== null) {
    return field.type === 'property_identifier' || field.type === 'private_property_identifier' ? field.text : undefined;
  }
  let name: string | undefined;
  for (const child of named(member)) {
    if (child.type === 'property_identifier' || child.type === 'private_property_identifier') name = child.text;
  }
  return name;
}

/** The name a call is made by: `walkTree(...)` of an identifier, `node.childForFieldName(...)` of a member. */
function calleeName(call: SyntaxNode): string | undefined {
  const called = call.childForFieldName('function') ?? call.childForFieldName('constructor');
  if (called === null) return undefined;
  if (called.type === 'identifier') return called.text;
  return called.type === 'member_expression' ? propertyOf(called) : undefined;
}

/** The branch of a conditional expression at a position, by field and then by position in the node. */
function branchOf(node: SyntaxNode, field: 'consequence' | 'alternative', at: number): SyntaxNode | null {
  return node.childForFieldName(field) ?? named(node)[at] ?? null;
}

/** The type names an annotation writes (`SyntaxNode` of `: SyntaxNode`, `Node` of `: Node | null`). */
function typeNamesOf(annotation: SyntaxNode): readonly string[] {
  const names: string[] = [];
  walk(annotation, (node) => {
    if (node.type === 'type_identifier' || node.type === 'identifier') names.push(node.text);
  });
  return names;
}

/** Whether a parameter is annotated as a syntax node. */
function isNodeParameter(parameter: SyntaxNode): boolean {
  const pattern = parameter.childForFieldName('pattern');
  const annotation = parameter.childForFieldName('type');
  if (pattern === null || pattern.type !== 'identifier' || annotation === null) return false;
  return typeNamesOf(annotation).some((name) => NODE_TYPE_NAMES.has(name));
}

/** Whether an expression answers a syntax node. */
function isNodeValue(expression: SyntaxNode | null, names: Names): boolean {
  if (expression === null) return false;
  switch (expression.type) {
    case 'identifier':
      return names.nodes.has(expression.text);
    case 'member_expression': {
      const property = propertyOf(expression);
      if (property === undefined || property === SOURCE_TEXT) return false;
      return NODE_PROPERTIES.has(property) || isNodeValue(objectOf(expression), names);
    }
    case 'parenthesized_expression':
    case 'as_expression':
    case 'satisfies_expression':
    case 'non_null_expression':
    case 'await_expression':
      return isNodeValue(named(expression)[0] ?? null, names);
    case 'ternary_expression':
      return isNodeValue(branchOf(expression, 'consequence', 1), names) || isNodeValue(branchOf(expression, 'alternative', 2), names);
    case 'call_expression':
      return NODE_ACCESSORS.has(calleeName(expression) ?? '');
    case 'subscript_expression': {
      // An element of a node list is a node: `node.namedChildren[0]`, `node.children[i]`.
      const held = objectOf(expression);
      if (held === null || held.type !== 'member_expression') return false;
      const property = propertyOf(held);
      return property === 'namedChildren' || property === 'children';
    }
    default:
      return false;
  }
}

/** Whether an expression holds a syntax node's own text. */
function isNodeText(expression: SyntaxNode | null, names: Names): boolean {
  if (expression === null) return false;
  switch (expression.type) {
    case 'identifier':
      return names.texts.has(expression.text);
    case 'member_expression': {
      const property = propertyOf(expression);
      if (property === undefined) return false;
      // `node.text` is the node's text; `node.text.length` and `node.text.trim` still hold it.
      if (property === SOURCE_TEXT) return isNodeValue(objectOf(expression), names);
      return isNodeText(objectOf(expression), names);
    }
    case 'parenthesized_expression':
    case 'as_expression':
    case 'satisfies_expression':
    case 'non_null_expression':
    case 'await_expression':
      return isNodeText(named(expression)[0] ?? null, names);
    case 'ternary_expression':
      return isNodeText(branchOf(expression, 'consequence', 1), names) || isNodeText(branchOf(expression, 'alternative', 2), names);
    case 'binary_expression': {
      const operator = expression.childForFieldName('operator');
      if (operator === null || (operator.text !== '+' && operator.text !== '??')) return false;
      return isNodeText(expression.childForFieldName('left'), names) || isNodeText(expression.childForFieldName('right'), names);
    }
    case 'template_string':
      return named(expression).some((child) => child.type === 'template_substitution' && isNodeText(named(child)[0] ?? null, names));
    case 'call_expression': {
      // `t.text(path)`, `tree.read(p)`, `readUtf8(...)`, `decoder.decode(bytes)`: a file's own characters.
      const called = expression.childForFieldName('function');
      const named_ = calleeName(expression);
      if (called === null || called.type !== 'member_expression') return named_ !== undefined && REPOSITORY_TEXT_READS.has(named_);
      const method = propertyOf(called);
      if (method === undefined) return false;
      if (REPOSITORY_TEXT_READS.has(method)) return true;
      // `text.trim()`, `text.slice(0, 4)`: a string read answers text; a map lookup does not.
      if (!TEXT_ANSWERS.has(method)) return false;
      if (isNodeText(objectOf(called), names)) return true;
      return named(expression.childForFieldName('arguments')).some((argument) => isNodeText(argument, names));
    }
    default:
      return false;
  }
}

/** Whether an expression answers a RegExp a pattern can be applied from. */
function isPattern(expression: SyntaxNode | null, names: Names): boolean {
  if (expression === null) return false;
  switch (expression.type) {
    case 'regex':
    case 'regex_pattern':
      return true;
    case 'identifier':
      return names.patterns.has(expression.text);
    case 'parenthesized_expression':
    case 'as_expression':
    case 'satisfies_expression':
      return isPattern(named(expression)[0] ?? null, names);
    case 'call_expression':
    case 'new_expression': {
      const built = expression.childForFieldName('constructor') ?? expression.childForFieldName('function') ?? named(expression)[0] ?? null;
      return built !== null && built.type === 'identifier' && built.text === 'RegExp';
    }
    default:
      return false;
  }
}

/** The node, text and pattern names of one file, to a fixed point: a name may be declared after its use. */
function collectNames(root: SyntaxNode): Names {
  const names: Names = {nodes: new Set(), texts: new Set(), patterns: new Set()};
  walk(root, (node) => {
    if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
      if (!isNodeParameter(node)) return;
      const pattern = node.childForFieldName('pattern');
      if (pattern !== null) names.nodes.add(pattern.text);
      return;
    }
    // A callback that receives the elements of a text list receives text: `t.lines(path).filter((line) => ...)`.
    if (node.type === 'call_expression') {
      const method = calleeName(node);
      if (method !== undefined && TEXT_LISTS.has(method)) {
        const object = objectOf(node.childForFieldName('function') as SyntaxNode);
        if (isNodeText(object, names)) {
          for (const argument of named(node.childForFieldName('arguments'))) {
            if (argument.type !== 'arrow_function' && argument.type !== 'function_expression') continue;
            for (const parameter of named(argument.childForFieldName('parameters'))) {
              const name = parameter.type === 'identifier' ? parameter : null;
              const pattern = name ?? parameter.childForFieldName('pattern');
              if (pattern !== null && pattern.type === 'identifier') names.texts.add(pattern.text);
            }
          }
        }
      }
    }
    // A node handed to the project's own walk is a node, whether or not it is annotated.
    if (node.type !== 'call_expression' || calleeName(node) !== 'walkTree') return;
    for (const argument of named(node.childForFieldName('arguments'))) {
      if (argument.type !== 'arrow_function' && argument.type !== 'function_expression' && argument.type !== 'function') continue;
      for (const parameter of named(argument.childForFieldName('parameters'))) {
        if (parameter.type === 'identifier') {
          names.nodes.add(parameter.text);
          continue;
        }
        const pattern = parameter.childForFieldName('pattern');
        if (pattern !== null && pattern.type === 'identifier') names.nodes.add(pattern.text);
      }
    }
  });
  const declarators: {name: string; value: SyntaxNode | null}[] = [];
  walk(root, (node) => {
    if (node.type !== 'variable_declarator') return;
    const name = node.childForFieldName('name');
    if (name === null || name.type !== 'identifier') return;
    declarators.push({name: name.text, value: node.childForFieldName('value')});
  });
  for (let round = 0; round <= declarators.length; round++) {
    let changed = false;
    for (const declarator of declarators) {
      if (declarator.value === null) continue;
      const held = declarator.name;
      if (!names.texts.has(held) && !names.nodes.has(held) && isNodeText(declarator.value, names)) {
        names.texts.add(held);
        changed = true;
        continue;
      }
      if (!names.nodes.has(held) && isNodeValue(declarator.value, names)) {
        names.nodes.add(held);
        changed = true;
      }
      if (!names.patterns.has(held) && isPattern(declarator.value, names)) {
        names.patterns.add(held);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return names;
}

/** One finding at the construct that made it. */
function findingAt(node: SyntaxNode, kind: FindingKind, file: string): Finding {
  return {
    file,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    kind,
    // A diagnostic: the characters are printed for a person, and no comparison reads them.
    construct: node.text.split('\n').join(' ').slice(0, 96),
  };
}

/** Every refusal of this rule in one parsed file, in the order the walk meets them. */
function findingsIn(parsed: ParsedSyntaxTree): readonly Finding[] {
  const names = collectNames(parsed.root);
  const findings: Finding[] = [];
  walk(parsed.root, (node) => {
    if (node.type !== 'call_expression') return;
    const called = node.childForFieldName('function');
    if (called === null || called.type !== 'member_expression') return;
    const method = propertyOf(called);
    if (method === undefined) return;
    const object = objectOf(called);
    if (TEXT_SEARCHES.has(method)) {
      if (isNodeText(object, names)) findings.push(findingAt(node, 'text-search', parsed.path));
      return;
    }
    if (REGEX_APPLICATIONS.has(method)) {
      // `text.matchAll(/x/g)`, `text.replace(/x/, 'y')`, `text.split(/x/)`, `text.search(/x/)`: the
      // pattern comes first, and the string it is applied to is repository text.
      const [first] = named(node.childForFieldName('arguments'));
      if (isNodeText(object, names) && isPattern(first ?? null, names)) findings.push(findingAt(node, 'regex-apply', parsed.path));
      return;
    }
    if (method !== 'test' && method !== 'exec') return;
    if (!isPattern(object, names)) return;
    if (!named(node.childForFieldName('arguments')).some((argument) => isNodeText(argument, names))) return;
    findings.push(findingAt(node, method === 'test' ? 'regex-test' : 'regex-exec', parsed.path));
  });
  return findings;
}

interface Scan {
  /** The repository-relative path of every file the guard read. */
  readonly files: readonly string[];
  readonly findings: readonly Finding[];
  /** Every file the guard could not read, with the reason: none means the scan is whole. */
  readonly unread: readonly string[];
}

/** Every TypeScript file under the guarded folder, in code point order. */
function guardedFiles(): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort(byCodePoint)) {
      const absolute = join(directory, entry);
      if (statSync(absolute).isDirectory()) {
        visit(absolute);
        continue;
      }
      // The rule covers every code reader under the folder: `.ts` today, and `.tsx` if a reader
      // of that grammar is added (`syntaxLanguageOf` names the grammar, not the extension).
      const language = syntaxLanguageOf(absolute);
      if (language === 'typescript' || language === 'tsx') files.push(relative(ROOT, absolute));
    }
  };
  visit(join(ROOT, GUARDED));
  return files.sort(byCodePoint);
}

/** One file's refusals, or the reason the file could not be read whole. */
async function scanFile(file: string, bytes: Uint8Array): Promise<{findings: readonly Finding[]; problem?: string}> {
  const read = await readSyntaxTree(file, bytes, (parsed) => findingsIn(parsed));
  if (!read.read) return {findings: [], problem: `${file}: ${JSON.stringify(read.unread)}`};
  if (!read.complete) return {findings: read.value, problem: `${file}: the parser did not read the file whole`};
  return {findings: read.value};
}

/** The whole guarded folder, parsed once for the cases below. */
let held: Promise<Scan> | undefined;
function guardedScan(): Promise<Scan> {
  held ??= (async (): Promise<Scan> => {
    const files = guardedFiles();
    const findings: Finding[] = [];
    const unread: string[] = [];
    for (const file of files) {
      const scanned = await scanFile(file, readFileSync(join(ROOT, file)));
      if (scanned.problem !== undefined) unread.push(scanned.problem);
      findings.push(...scanned.findings);
    }
    return {files, findings, unread};
  })();
  return held;
}

/** The refusals a source snippet draws, run through the same checker the folder scan uses. */
async function findingsOf(snippet: readonly string[]): Promise<readonly Finding[]> {
  const scanned = await scanFile('snippet.ts', new TextEncoder().encode(snippet.join('\n')));
  if (scanned.problem !== undefined) throw new Error(`the fixture does not parse: ${scanned.problem}`);
  return scanned.findings;
}

/** A finding as `file kind`, the unit the debt list counts. */
function summaryOf(findings: readonly Finding[]): readonly string[] {
  return findings.map((entry) => `${entry.file} ${entry.kind}`).sort(byCodePoint);
}

/** Every finding with its full path, line and column, for a person reading a failure. */
function located(findings: readonly Finding[]): string {
  return findings.map((entry) => `${join(ROOT, entry.file)}:${entry.line}:${entry.column} ${entry.kind} ${entry.construct}`).join('\n');
}

/**
 * The source-text parses that stand under `src/extract` today (madarch-mwhd.3's migration debt).
 *
 * The list is exact: the tree case fails when a finding is missing from it and when one of its
 * entries no longer exists. It is empty when the migration is done, and then the guard is the
 * zero-finding check the change blocks CI on.
 */
const PRESENT_DEBT: readonly string[] = [
  // The readers this migration has not reached yet (madarch-mwhd.3). Each entry is one construct the
  // guard sees over a file's whole text — a file's own characters, never a node's, which the older
  // rule already refused; the tree case fails when the list and the tree disagree in either direction,
  // so a new pattern anywhere under src/extract turns this test red. The environment reader, the
  // stack passport, the go.mod reader and the compose reader are migrated; the SQL access reader, the
  // symbol-site reader and one contract reader are the remaining work.
  'src/extract/contracts/ts-code.ts regex-apply',
  'src/extract/data-model/access.ts regex-apply',
  'src/extract/data-model/access.ts regex-apply',
  'src/extract/data-model/access.ts regex-apply',
  'src/extract/data-model/access.ts regex-apply',
  'src/extract/data-model/access.ts regex-apply',
  'src/extract/data-model/access.ts regex-apply',
  'src/extract/data-model/access.ts regex-exec',
  'src/extract/data-model/access.ts regex-exec',
  'src/extract/data-model/access.ts regex-exec',
  'src/extract/data-model/access.ts regex-exec',
  'src/extract/data-model/access.ts regex-test',
  'src/extract/data-model/access.ts regex-test',
  'src/extract/data-model/access.ts regex-test',
  'src/extract/operations/deploy.ts regex-exec',
  'src/extract/operations/env.ts text-search',
  'src/extract/operations/source.ts text-search',
  'src/extract/operations/symbol-sites.ts regex-apply',
  'src/extract/operations/symbol-sites.ts regex-apply',
  'src/extract/operations/symbol-sites.ts regex-apply',
  'src/extract/operations/symbol-sites.ts regex-exec',
  'src/extract/operations/symbol-sites.ts regex-test',
].sort(byCodePoint);

describe('the source-text rule', () => {
  test('refuses the Go message read that re-read a receiver out of its text', async () => {
    // The shape of src/extract/contracts/go-code.ts:318-320: the operand's fields are in the
    // tree, and the reader takes its text and asks a regex for them again.
    const findings = await findingsOf([
      'function readMessage(node: SyntaxNode): void {',
      "  const object = node.childForFieldName('function')?.childForFieldName('operand')?.text;",
      '  const match = object === undefined ? null : /^([A-Za-z_][\\w]*)\\.([A-Za-z_][\\w]*)$/.exec(object);',
      '  if (match !== null) reads.push(match[1]);',
      '}',
    ]);
    expect(findings.map((entry) => `${entry.line} ${entry.kind}`)).toEqual(['3 regex-exec']);
  });

  test('allows the same read through the selector_expression fields the grammar gives', async () => {
    const findings = await findingsOf([
      'function readMessage(node: SyntaxNode): void {',
      "  const called = node.childForFieldName('function');",
      "  if (called === null || called.type !== 'selector_expression') return;",
      "  const operand = called.childForFieldName('operand');",
      "  const field = called.childForFieldName('field');",
      '  if (operand === null || field === null) return;',
      '  reads.push({owner: operand.id, field: field.id});',
      '}',
    ]);
    expect(findings).toEqual([]);
  });

  test('refuses .includes over a statement text', async () => {
    // The shape of src/extract/contracts/go-code.ts:338.
    const findings = await findingsOf([
      'function commits(statement: SyntaxNode): boolean {',
      "  return statement.type === 'if_statement' && statement.text.includes('CommitMessages');",
      '}',
    ]);
    expect(findings.map((entry) => `${entry.line} ${entry.kind}`)).toEqual(['2 text-search']);
  });

  test('refuses a search over a variable that holds a node text', async () => {
    const findings = await findingsOf([
      'function ownerOf(node: SyntaxNode): string {',
      "  const receiver = node.childForFieldName('field')?.text;",
      "  return receiver === undefined ? '' : receiver.slice(0, receiver.indexOf('.'));",
      '}',
    ]);
    expect(findings.map((entry) => `${entry.line} ${entry.kind}`)).toEqual(['3 text-search']);
  });

  test('refuses a pattern built at run time over a node text', async () => {
    const findings = await findingsOf([
      'function scanned(node: SyntaxNode): boolean {',
      "  return new RegExp('[A-Z]+').test(node.text);",
      '}',
    ]);
    expect(findings.map((entry) => `${entry.line} ${entry.kind}`)).toEqual(['2 regex-test']);
  });

  test('refuses a pattern kept in a variable, so an alias cannot evade the rule', async () => {
    const findings = await findingsOf([
      'const PATTERN = /^[A-Z]+$/;',
      'function scanned(node: SyntaxNode): boolean {',
      '  return PATTERN.test(node.text);',
      '}',
    ]);
    expect(findings.map((entry) => `${entry.line} ${entry.kind}`)).toEqual(['3 regex-test']);
  });

  test('refuses a pattern applied to a whole file read from the tree', async () => {
    // `/PHANTOM/.test(t.text(path))` and `t.text(path).match(...)`: the file's characters, not a node's.
    const findings = await findingsOf([
      'function scan(t: TreeText, path: string): boolean {',
      '  return /PHANTOM/.test(t.text(path));',
      '}',
    ]);
    expect(findings.map((entry) => `${entry.line} ${entry.kind}`)).toEqual(['2 regex-test']);
  });

  test('refuses every pattern application form over a whole file read', async () => {
    // Each line is one shape a reader reached for during this migration; all of them are refused.
    const findings = await findingsOf([
      'function scan(t: TreeText, path: string, node: SyntaxNode): boolean {',
      '  const text = t.text(path);',
      '  void text.matchAll(/PHANTOM/g);',
      "  void text.replace(/PHANTOM/g, 'x');",
      '  void text.split(/PHANTOM/);',
      '  void text.search(/PHANTOM/);',
      "  void t.lines(path).filter((line) => /PHANTOM/.test(line));",
      '  void new RegExp("PHANTOM").test(text);',
      '  void node.text.matchAll(/PHANTOM/g);',
      '  return false;',
      '}',
    ]);
    expect(findings.map((entry) => `${entry.line} ${entry.kind}`)).toEqual([
      '3 regex-apply', '4 regex-apply', '5 regex-apply', '6 regex-apply', '7 regex-test', '8 regex-test', '9 regex-apply',
    ]);
  });

  test('allows structured tool output matched with a fixed pattern, and nothing else', async () => {
    // A program's own output is not repository text: a `git log` line with a fixed format is the one
    // shape the change allows a pattern to read (the extractor reads commits that way).
    const findings = await findingsOf([
      'function readLog(output: string): string[] {',
      '  return output.split(";").filter((line) => /^[0-9a-f]{40}/.test(line));',
      '}',
    ]);
    expect(findings).toEqual([]);
  });

  test('allows a node text handed to a diagnostic and measured, because nothing matches it', async () => {
    // The same holding of a text as the refused case above: `held` is a node's text, and this is
    // allowed because the reader only counts lines, cuts a prefix and prints. No pattern and no
    // search asks what the characters say.
    const findings = await findingsOf([
      'function describe(node: SyntaxNode, path: string): string {',
      '  const held = node.text;',
      "  const lines = held.split('\\n').length;",
      "  return path + ':' + lines + ': ' + held.slice(0, 60);",
      '}',
      'function message(node: SyntaxNode): string {',
      "  return 'unreadable ' + node.type + ': ' + node.text;",
      '}',
    ]);
    expect(findings).toEqual([]);
  });
});

describe('src/extract', () => {
  test('reads every code file under src/extract whole, so a parse gap cannot hide a finding', async () => {
    const scan = await guardedScan();
    expect(scan.unread).toEqual([]);
    expect(scan.files.length).toBeGreaterThan(50);
    expect(scan.files.every((file) => file.startsWith(`${GUARDED}/`))).toBe(true);
    for (const file of scan.files) {
      const language = syntaxLanguageOf(file);
      expect(language === 'typescript' || language === 'tsx').toBe(true);
    }
  }, 120_000);

  test('holds no source-text parse beyond the debt this test names', async () => {
    const scan = await guardedScan();
    const actual = summaryOf(scan.findings);
    // The message is assembled here rather than left to a diff: a person needs the full path, the
    // line and the column of every finding, and which of them the list already names.
    if (actual.join('\n') !== PRESENT_DEBT.join('\n')) {
      const alreadyNamed = new Set(actual.filter((entry) => PRESENT_DEBT.includes(entry)));
      throw new Error([
        'The source-text parses under src/extract changed (madarch-mwhd.3, parser-source-guard).',
        'Every finding this guard found, with its full path, line and column:',
        located(scan.findings) || '(none)',
        `Of those, ${alreadyNamed.size} of ${actual.length} are named by PRESENT_DEBT; this test names:`,
        PRESENT_DEBT.join('\n') || '(none)',
        'A finding this test does not name is a new source-text parse: read the node fields the grammar gives instead.',
        'A fixed parse must leave PRESENT_DEBT, so the list shrinks to none and the guard becomes blocking.',
      ].join('\n'));
    }
    expect(actual).toEqual(PRESENT_DEBT);
  }, 120_000);
});
