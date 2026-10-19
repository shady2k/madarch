/**
 * Stage 4's pure per-file reading (madarch-tzte.21.6, decision 0026's "semantic
 * resolution"): the names a file takes from other modules, and the places the
 * file mentions a name — a call, a mention, an `extends` or an `implements`
 * clause. What each mention resolves to is `resolution-facts.ts`'s business;
 * this module answers only what the file's own bytes say, so the same bytes at
 * the same path answer the same findings on every machine and in every run.
 *
 * The tree is the one stage 3 already parsed (`readSyntaxTree`,
 * `syntax-extract.ts`): one grammar set, one span counting, so a mention's
 * place and a declaration's place are measured the same way and a resolver
 * downstream can compare them.
 *
 * **What this reader does not count as a mention.** A name a declaration
 * introduces (its `name`, a class field's `property`, a Go spec's `name`), a
 * member's name in an access (`order.total` — `order` is the mention, `total`
 * is the member), a key of an object literal or of a Go keyed element, a label,
 * a name a destructuring pattern binds, an import's or an export's own name,
 * and a name inside a type annotation's *position* of a type parameter. A
 * property access is skipped deliberately: which member of an object a name
 * reaches is a type checker's answer, and a syntactic reader that guessed it
 * would draw edges to symbols nothing calls.
 *
 * **What is read through a namespace.** A `* as ns` import of a file of this
 * repository makes `ns.name` one mention of `name`, reached through the binding
 * `ns`, so a resolver ties it to the symbol `name` of the file `ns` names. A
 * namespace import of a package outside the repository binds nothing this
 * reader can follow, and its uses are the caller's gaps, not this reader's.
 *
 * **A mention a parameter binds is out of the claim.** A parameter is no symbol
 * of the schema's reading (`syntax-extract.ts` reads declarations, not
 * parameters), so a mention of a name a parameter of an enclosing declaration
 * binds names that parameter. The mention says so (`parameterBound`) rather
 * than leaving the resolver to draw an edge to the outer import of that name.
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { byCodePoint } from '../../model/order.js';
import type { CoverageGap } from '../facts.js';
import {
  readSyntaxTree, spanFactory,
  type ParsedSyntaxTree, type SyntaxLanguage, type SyntaxSpan,
} from './syntax-extract.js';

/** What a mention does at its place; the resolver turns the first three into edge kinds. */
export const MENTION_USES = ['call', 'extends', 'implements', 'mention'] as const;
export type MentionUse = (typeof MENTION_USES)[number];

/** What a name an import binds stands for in the file that defines it. */
export type ImportedName =
  /** One of the target file's named declarations (`import { create }`, `import { create as make }`). */
  | { readonly form: 'named'; readonly name: string }
  /** The target file's default export (`import create from`). */
  | { readonly form: 'default' }
  /** The whole target file (`import * as orders from`), whose own members are mentions of their own. */
  | { readonly form: 'namespace' };

/** One name a file binds from another module. */
export interface ExtractedResolutionImport {
  /** The name the binding has in this file (`c` for `import { b as c }`, `ns` for `* as ns`, `fmt` for Go's `"fmt"`). */
  readonly local: string;
  /** The specifier as written, without its quotes (`./order.js`, `lodash`, `example.com/x/order`). */
  readonly specifier: string;
  readonly imported: ImportedName;
  /** Where the binding stands: the local name's own token, or the specifier's for a Go import that names no name. */
  readonly span: SyntaxSpan;
}

/** One place a file mentions a name. */
export interface ExtractedResolutionMention {
  /** The name as written at the mention (`create`, `Order`). */
  readonly name: string;
  /** What the name does here: a call's callee, an `extends` or `implements` clause, or a plain mention. */
  readonly use: MentionUse;
  /** Whether the mention reads the name or writes it (an assignment's target, an increment). */
  readonly access: 'read-access' | 'write-access';
  /** Where the name stands: the name token's own place, which is the occurrence's place. */
  readonly span: SyntaxSpan;
  /** The namespace binding the name is reached through (`ns.name`), where it is reached through one. */
  readonly through?: string;
  /** Whether a parameter of a declaration the mention stands in binds this name: the mention names that parameter. */
  readonly parameterBound: boolean;
}

/** Everything this reader found in one file. */
export interface ExtractedFileResolution {
  /** The file's repository path, as it was given. */
  readonly path: string;
  /** The language the file was read as, or `null` where no grammar of stage 3 reads it. */
  readonly language: SyntaxLanguage | null;
  /** Whether a syntax tree was made and walked. */
  readonly parsed: boolean;
  /** The names the file binds from other modules, in code point order of the local name. */
  readonly imports: readonly ExtractedResolutionImport[];
  /** The places the file mentions a name, in the file's own order. */
  readonly mentions: readonly ExtractedResolutionMention[];
  /** What this reader could not read: a language with no grammar, bytes that are not text, a parser's error, a `require` binding. */
  readonly unread: readonly CoverageGap[];
}

/**
 * Reads one file's bytes and answers what it binds and what it mentions. Pure:
 * the two arguments decide the answer, and nothing else does.
 */
export async function extractFileResolution(path: string, bytes: Uint8Array): Promise<ExtractedFileResolution> {
  const read = await readSyntaxTree(path, bytes, (file) => collectFileResolution(file));
  if (!read.read) return { path, language: read.language, parsed: false, imports: [], mentions: [], unread: read.unread };
  const gaps: CoverageGap[] = [...read.value.unread];
  // A tree with an error node was read as far as the parser could go: what it
  // found stands, and the file's coverage says it was not read whole.
  if (!read.complete) gaps.push({ what: path, reason: 'error' });
  return {
    path,
    language: read.language,
    parsed: true,
    imports: read.value.imports,
    mentions: read.value.mentions,
    unread: mergeGaps(gaps),
  };
}

/**
 * What a file this reader did not read has: nothing bound, nothing mentioned,
 * and the gap that says why. A caller that knows the file's bytes are not
 * source text — a symbolic link holds the path it points at, a submodule stands
 * in another repository — uses this to publish the file's coverage without
 * pretending it was read.
 */
export function unreadFileResolution(path: string, reason: CoverageGap['reason']): ExtractedFileResolution {
  return { path, language: null, parsed: false, imports: [], mentions: [], unread: [{ what: path, reason }] };
}

/**
 * What one parsed file binds and mentions. The two passes over the tree are
 * deliberate: the second has to know which names are namespace bindings before
 * it can read `ns.name` as one mention of `name`.
 */
export function collectFileResolution(file: ParsedSyntaxTree): {
  readonly imports: readonly ExtractedResolutionImport[];
  readonly mentions: readonly ExtractedResolutionMention[];
  readonly unread: readonly CoverageGap[];
} {
  const go = file.language === 'go';
  const text = file.text;
  const spanOf = spanFactory(text);
  const unread: CoverageGap[] = [];

  // ---- the bindings ------------------------------------------------------

  const imports: ExtractedResolutionImport[] = [];
  const record = (local: string, specifier: string, imported: ImportedName, at: SyntaxNode): void => {
    if (!IDENTIFIER.test(local) || specifier.trim() === '') return;
    imports.push({ local, specifier, imported, span: spanOf(at) });
  };
  const importNodes = descendants(file.root, go ? ['import_spec'] : ['import_statement']);
  for (const node of importNodes) {
    if (go) {
      const path = node.childForFieldName('path');
      if (path === null) continue;
      const specifier = unquote(text.slice(path.startIndex, path.endIndex));
      const named = node.childForFieldName('name');
      const local = named === null ? goPackageName(specifier) : text.slice(named.startIndex, named.endIndex);
      // A Go import names a package of another directory, never one symbol and
      // never a file of this repository: the binding is recorded so its uses are
      // named as the package's, and never resolved to a symbol.
      record(local, specifier, { form: 'namespace' }, named ?? path);
      continue;
    }
    const source = node.childForFieldName('source');
    if (source === null) continue;
    const specifier = unquote(text.slice(source.startIndex, source.endIndex));
    // The clause is the import statement's own named child, not a field of it:
    // an `import 'x'` written for its side effect has none, and binds nothing.
    for (const clause of node.namedChildren) {
      if (clause === null || clause.type !== 'import_clause') continue;
      for (const child of clause.namedChildren) {
        if (child === null) continue;
        if (child.type === 'namespace_import') {
          const name = child.namedChildren.find((inner) => inner !== null && inner.type === 'identifier');
          if (name !== null && name !== undefined) record(text.slice(name.startIndex, name.endIndex), specifier, { form: 'namespace' }, name);
          continue;
        }
        if (child.type === 'named_imports') {
          for (const specifierNode of child.namedChildren) {
            if (specifierNode === null || specifierNode.type !== 'import_specifier') continue;
            const imported = specifierNode.childForFieldName('name');
            const alias = specifierNode.childForFieldName('alias');
            if (imported === null) continue;
            const local = alias === null ? imported : alias;
            record(text.slice(local.startIndex, local.endIndex), specifier, { form: 'named', name: unquote(text.slice(imported.startIndex, imported.endIndex)) }, local);
          }
          continue;
        }
        // The default import: a bare identifier in the clause.
        if (child.type === 'identifier') record(text.slice(child.startIndex, child.endIndex), specifier, { form: 'default' }, child);
      }
    }
  }

  // The namespaces this reader can follow: a `* as ns` whose specifier names a
  // file of this repository. A package's namespace binds nothing here.
  const namespaces = new Set<string>(
    imports.filter((entry) => entry.imported.form === 'namespace' && isRelative(entry.specifier)).map((entry) => entry.local),
  );

  // ---- the mentions ------------------------------------------------------

  const mentions: ExtractedResolutionMention[] = [];
  /** The parameter names bound by each declaration the walk stands in, outermost first. */
  const parameters: string[][] = [];

  const parameterBound = (name: string): boolean => parameters.some((held) => held.includes(name));

  const recordMention = (node: SyntaxNode, use: MentionUse, through?: string): void => {
    const name = text.slice(node.startIndex, node.endIndex);
    // Go's blank identifier names nothing: it is a place that takes a value and
    // binds no name, so it is no mention of one.
    if (!IDENTIFIER.test(name) || (go && name === '_')) return;
    const parent = node.parent;
    if (parent === null || isBindingName(node, parent)) return;
    const access = isWriteTarget(node, parent, go) ? 'write-access' : 'read-access';
    mentions.push({
      name,
      use,
      access,
      span: spanOf(node),
      ...(through === undefined ? {} : { through }),
      parameterBound: parameterBound(name),
    });
  };

  /** The use a name has in an expression position: a call's callee is a call, everything else a mention. */
  const calleeUse = (node: SyntaxNode): MentionUse => {
    const parent = node.parent;
    if (parent === null) return 'mention';
    const callee = parent.childForFieldName('function');
    return parent.type === 'call_expression' && callee !== null && callee.id === node.id ? 'call' : 'mention';
  };

  const visit = (node: SyntaxNode, heritage: MentionUse | undefined): void => {
    const type = node.type;
    // Bindings were read in the first pass, and an export clause names no
    // mention of this file's own (a re-export's target is the importing file's
    // gap, and a local `export { a }` is the declaration's own business).
    if (type === 'import_statement' || type === 'import_spec' || type === 'export_clause' || type === 'namespace_export') return;
    if (type === 'export_statement' && !go) {
      const declaration = node.childForFieldName('declaration');
      if (declaration !== null) visit(declaration, undefined);
      // A re-export (`export { a } from './x'`, `export * from './x'`) hands
      // another module's names on: nothing here binds them in this file.
      return;
    }
    if (!go && (type === 'require_call' || isRequireCall(node, text))) {
      unread.push({ what: `the CommonJS binding of ${file.path} at line ${spanOf(node).startLine} (a require names a module this reader does not follow)`, reason: 'unsupported' });
    }
    if (FUNCTION_NODES.has(type)) {
      const held = parameterNamesOf(node, text, go);
      parameters.push(held);
      for (const child of node.namedChildren) {
        if (child === null || isBindingPattern(child) || isGoBindingChild(node, child, text)) continue;
        visit(child, undefined);
      }
      parameters.pop();
      return;
    }
    if (type === 'catch_clause') {
      const parameter = node.childForFieldName('parameter');
      parameters.push(parameter === null ? [] : patternNames(parameter, text));
      for (const child of node.namedChildren) {
        if (child === null || (parameter !== null && child.id === parameter.id)) continue;
        visit(child, undefined);
      }
      parameters.pop();
      return;
    }
    const declared = !go ? HERITAGE_CLAUSES[type] : undefined;
    if (declared !== undefined) {
      for (const child of node.namedChildren) if (child !== null) visit(child, declared);
      return;
    }
    if (type === 'generic_type') {
      const name = node.childForFieldName('name');
      if (name !== null) visit(name, heritage);
      for (const child of node.namedChildren) {
        if (child === null || (name !== null && child.id === name.id)) continue;
        visit(child, undefined);
      }
      return;
    }
    if (type === 'type_arguments' || type === 'type_parameters') {
      for (const child of node.namedChildren) if (child !== null) visit(child, undefined);
      return;
    }
    if (MEMBER_ACCESS.has(type)) {
      const object = node.childForFieldName(go ? 'operand' : 'object');
      const member = node.childForFieldName(go ? 'field' : 'property');
      if (object !== null && member !== null && isNameNode(object, go)) {
        const through = text.slice(object.startIndex, object.endIndex);
        if (namespaces.has(through) && !parameterBound(through)) {
          // `ns.name`: the name that can name a symbol is the member's, and it
          // is reached through the namespace binding.
          const use = calleeUse(node);
          const memberName = text.slice(member.startIndex, member.endIndex);
          if (IDENTIFIER.test(memberName)) {
            mentions.push({
              name: memberName,
              use,
              access: 'read-access',
              span: spanOf(member),
              through,
              parameterBound: false,
            });
          }
          return;
        }
      }
      // Any other access: the object is a name this reader may know, and the
      // member is not — which member of which type it reaches is a type
      // checker's answer, not this reader's.
      if (object !== null) visit(object, heritage);
      for (const child of node.namedChildren) {
        if (child === null || (object !== null && child.id === object.id) || (member !== null && child.id === member.id)) continue;
        visit(child, undefined);
      }
      return;
    }
    if (isNameNode(node, go)) {
      recordMention(node, heritage ?? calleeUse(node));
      return;
    }
    for (const child of node.namedChildren) {
      if (child === null || isBindingPattern(child) || isGoBindingChild(node, child, text)) continue;
      visit(child, heritage);
    }
  };
  visit(file.root, undefined);

  return {
    imports: [...imports].sort((left, right) => byCodePoint(left.local, right.local) || byCodePoint(left.specifier, right.specifier) || left.span.startByte - right.span.startByte),
    mentions: [...mentions].sort((left, right) => left.span.startByte - right.span.startByte || left.span.endByte - right.span.endByte),
    unread: mergeGaps(unread),
  };
}

// ---- the grammars' own vocabulary -----------------------------------------

/** The name nodes this reader reads, by language: the tokens a grammar spells a name with. */
const TS_NAME_NODES: readonly string[] = ['identifier', 'shorthand_property_identifier', 'type_identifier'];
// A Go `field_identifier` is always a member's name (a selector's field, a
// struct's field, an interface's method) and a `package_identifier` the clause's
// own name: neither is a name this reader resolves, and both are skipped by the
// list rather than by a rule about their parent.
const GO_NAME_NODES: readonly string[] = ['identifier', 'type_identifier'];

/** The nodes a name in a member access stands at, and nodes whose `field` is the member. */
const MEMBER_ACCESS: ReadonlySet<string> = new Set(['member_expression', 'subscript_expression', 'qualified_type']);

/** The clauses that make a name an inheritance rather than a mention. */
const HERITAGE_CLAUSES: Readonly<Record<string, MentionUse>> = {
  // TypeScript: `class A extends B implements C`, `interface I extends J`.
  extends_clause: 'extends',
  extends_type_clause: 'extends',
  implements_clause: 'implements',
};

/** The declarations whose parameters shadow a name inside them. */
const FUNCTION_NODES: ReadonlySet<string> = new Set([
  'abstract_method_signature', 'arrow_function', 'func_literal', 'function', 'function_declaration', 'function_expression',
  'function_signature', 'generator_function', 'generator_function_declaration', 'method_definition', 'method_declaration',
  'method_signature',
]);

/** The fields of a node whose name is a *binding*: a name the node introduces, never a mention of one. */
const BINDING_FIELDS: readonly string[] = ['alias', 'field', 'key', 'label', 'name', 'pattern', 'property'];

/** The parents whose `name` field is a mention rather than a binding: a type's own name in a generic use, a JSX element. */
const NAME_FIELD_IS_A_MENTION: ReadonlySet<string> = new Set(['generic_type', 'jsx_closing_element', 'jsx_opening_element', 'jsx_self_closing_element']);

/** The nodes that bind the names they hold, so nothing inside one is a mention. */
const BINDING_PATTERNS: ReadonlySet<string> = new Set([
  'array_pattern', 'assignment_pattern', 'object_pattern', 'rest_pattern', 'shorthand_property_identifier_pattern',
]);

/** The identifier rule: a name in the language's own alphabet, with `_`, `$` and a private member's `#`. */
const IDENTIFIER = /^#?[\p{ID_Start}_$][\p{ID_Continue}_$]*$/u;

/** Whether a node is one this reader reads as a name. */
function isNameNode(node: SyntaxNode, go: boolean): boolean {
  return (go ? GO_NAME_NODES : TS_NAME_NODES).includes(node.type);
}

/**
 * Whether a node binds the names it holds rather than mentioning them. A Go
 * short variable declaration's left side and a keyed element's key introduce
 * names (`shape := …`, `Shape{Width: 2}`) where the same positions in an
 * assignment and in a value mention them.
 */
function isBindingPattern(node: SyntaxNode): boolean {
  return BINDING_PATTERNS.has(node.type);
}

/** Whether a Go child of a node is a binding rather than a mention. */
function isGoBindingChild(parent: SyntaxNode, child: SyntaxNode, text: string): boolean {
  if (parent.type === 'short_var_declaration') {
    const left = parent.childForFieldName('left');
    if (left !== null && left.id === child.id) return true;
  }
  if (parent.type === 'keyed_element') {
    const key = parent.namedChildren[0];
    if (key === null || key === undefined) return false;
    if (key.id === child.id) return true;
    // The grammar writes the key's name beside its own element node, so the
    // identifier carrying the same text is the key too, and the value's
    // identifier — where one stands — is the mention.
    return child.type === 'identifier' && text.slice(key.startIndex, key.endIndex) === text.slice(child.startIndex, child.endIndex);
  }
  return false;
}

/**
 * Whether a name is one its parent *introduces*: the `name`, `key`, `label`,
 * `property`, `field`, `alias` or `pattern` field of a node that is no generic
 * type or JSX element. A member's name is here too: `order.total` mentions
 * `order`, and `total` is the member the access reaches.
 */
function isBindingName(node: SyntaxNode, parent: SyntaxNode): boolean {
  if (parent.type === 'variable_declarator' || NAME_FIELD_IS_A_MENTION.has(parent.type)) {
    // A generic type's own name and a JSX element's name are mentions; a
    // declarator's `name` field is the binding, and its `value` is not.
    const name = parent.childForFieldName('name');
    return parent.type === 'variable_declarator' && name !== null && name.id === node.id;
  }
  for (const field of BINDING_FIELDS) {
    const held = parent.childForFieldName(field);
    if (held !== null && held.id === node.id) return true;
  }
  return false;
}

/** Whether a mention stands in an assignment's target or an increment: the name is written, not read. */
function isWriteTarget(node: SyntaxNode, parent: SyntaxNode, go: boolean): boolean {
  if (go) {
    if (parent.type === 'inc_statement' || parent.type === 'dec_statement') return true;
    if (parent.type === 'assignment_statement') {
      const left = parent.childForFieldName('left');
      return left !== null && (left.id === node.id || within(left, node));
    }
    return false;
  }
  if (parent.type === 'update_expression') return true;
  if (parent.type === 'assignment_expression' || parent.type === 'augmented_assignment_expression') {
    const left = parent.childForFieldName('left');
    return left !== null && (left.id === node.id || within(left, node));
  }
  return false;
}

/** Whether a node stands inside another. */
function within(outer: SyntaxNode, node: SyntaxNode): boolean {
  return node.startIndex >= outer.startIndex && node.endIndex <= outer.endIndex;
}

/** The parameter names one declaration binds: what shadows a name inside it. */
function parameterNamesOf(node: SyntaxNode, text: string, go: boolean): string[] {
  const names: string[] = [];
  // A Go declaration binds the names of its result list too (`func f() (out int)`),
  // and a name it binds shadows whatever else the file calls that name.
  const fields = go ? ['parameters', 'result'] : ['parameters'];
  const lists = fields.flatMap((field) => node.childrenForFieldName(field)).filter((held): held is SyntaxNode => held !== null);
  for (const list of lists) {
    for (const parameter of list.namedChildren) {
      if (parameter === null) continue;
      const pattern = parameter.childForFieldName('pattern');
      if (pattern !== null) {
        names.push(...patternNames(pattern, text));
        continue;
      }
      const named = parameter.childrenForFieldName('name').filter((held): held is SyntaxNode => held !== null);
      for (const held of named) names.push(...patternNames(held, text));
      if (go && named.length === 0 && parameter.type === 'identifier') names.push(text.slice(parameter.startIndex, parameter.endIndex));
    }
  }
  return [...new Set(names)];
}

/** Every name a binding pattern writes: `x`, `{ a, b: c }`, `[d]`, `...rest`. */
function patternNames(pattern: SyntaxNode, text: string): string[] {
  const names: string[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'type_annotation') return;
    if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') {
      const name = text.slice(node.startIndex, node.endIndex);
      if (IDENTIFIER.test(name)) names.push(name);
      return;
    }
    for (const child of node.namedChildren) if (child !== null) visit(child);
  };
  visit(pattern);
  return names;
}

/** Every node of the types named, in the file's own order. */
function descendants(root: SyntaxNode, types: readonly string[]): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  const visit = (node: SyntaxNode): void => {
    if (types.includes(node.type)) {
      found.push(node);
      return;
    }
    for (const child of node.namedChildren) if (child !== null) visit(child);
  };
  visit(root);
  return found;
}

/** The text of a quoted specifier without its quotes (`'./x'`, `"./x"`, a Go back-quoted path). */
function unquote(written: string): string {
  const trimmed = written.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith("'") || trimmed.startsWith('"') || trimmed.startsWith('`'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** The name a Go import binds when it names none: the last segment of the package's path. */
function goPackageName(specifier: string): string {
  const parts = specifier.split('/').filter((part) => part !== '');
  return parts.length === 0 ? specifier : parts[parts.length - 1]!;
}

/** Whether a specifier names a path beside this file rather than a package outside the repository. */
function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/** Whether a call is a CommonJS `require('…')`, whose binding this reader does not follow. */
function isRequireCall(node: SyntaxNode, text: string): boolean {
  if (node.type !== 'call_expression') return false;
  const callee = node.childForFieldName('function');
  return callee !== null && callee.type === 'identifier' && text.slice(callee.startIndex, callee.endIndex) === 'require';
}

/** The gaps one `what` once, in code point order of `what`, as the schema reads a coverage's list. */
function mergeGaps(gaps: readonly CoverageGap[]): CoverageGap[] {
  const byWhat = new Map<string, CoverageGap>();
  for (const gap of gaps) if (!byWhat.has(gap.what)) byWhat.set(gap.what, gap);
  return [...byWhat.keys()].sort(byCodePoint).map((what) => byWhat.get(what)!);
}
