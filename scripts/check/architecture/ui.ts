import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript-api';

/** Native controls and disclosure/table structure belong to components/ui. */
export const RAW_UI_ELEMENTS = new Set([
  'button', 'input', 'select', 'option', 'optgroup', 'textarea', 'label', 'form',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'details', 'summary', 'dialog', 'progress', 'meter',
  // The kit covers every construct a page reads in (madarch-64o5.130): a page draws no heading, paragraph, list, link,
  // code block, quote, figure or page region of its own, so no page can hold a second component for that job.
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'a', 'pre', 'code', 'strong', 'em',
  'b', 'i', 'small', 'blockquote', 'figure', 'figcaption', 'article', 'section', 'header', 'footer', 'nav', 'aside',
  'time', 'address', 'hr', 'q', 'cite', 'abbr', 'kbd', 'samp', 'var', 'mark', 'sub', 'sup',
]);
export const UI_RULES = ['raw-ui-element', 'inline-style', 'styled-components', 'arbitrary-tailwind', 'local-styled-component', 'dialog-whole-scroll', 'sidebar-missing-icon', 'button-variant', 'button-disabled-reason', 'kit-duplicate-export'] as const;
export type UiRule = typeof UI_RULES[number];
export interface UiDebt {
  readonly rule: UiRule;
  readonly file: string;
  readonly subject: string;
}
export interface UiViolation extends UiDebt {
  readonly line: number;
}
export const UI_BASELINE = '.architecture/ui-violations.json';

/** The kit's presses (madarch-64o5.127): one look, so a page passes none of the shape props the kit dropped. */
export const CONTROL_NAMES = ['Button', 'IconButton', 'Toggle', 'SegmentedChoice'] as const;
export const CONTROL_MODULES = /(?:^|\/)(?:components\/ui|ui)\/(?:button|toggle|segmented-choice)\.js$/;
export const SHAPE_PROPS = ['variant', 'size', 'className'] as const;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const debtKey = (entry: UiDebt): string => JSON.stringify([entry.rule, entry.file, entry.subject]);

export function isUiSource(file: string): boolean {
  return file.startsWith('wiki/app/src/') && file.endsWith('.tsx') &&
    !file.startsWith('wiki/app/src/components/ui/') &&
    !/(?:^|\/)(?:__tests__|__fixtures__)\//.test(file) && !/\.(?:test|spec)\.tsx$/.test(file);
}

/** A kit component or value one file exports, with the line it is written on. */
export interface KitExport {
  readonly name: string;
  readonly line: number;
  readonly file: string;
}

/** The components and values one kit file exports: the names the kit offers a page. */
export function kitExports(file: string, source: string): KitExport[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: KitExport[] = [];
  const lineOf = (node: ts.Node): number => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
  for (const statement of tree.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) found.push({ name: statement.name.text, line: lineOf(statement), file });
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) found.push({ name: declaration.name.text, line: lineOf(declaration), file });
    }
  }
  return found.sort((left, right) => compare(left.name, right.name) || left.line - right.line);
}

/**
 * A kit name offered by two files is two components for one job (madarch-64o5.130): the first file in code point order
 * keeps it, every later one is refused. The rule reads names, so a second component for a job under another name — a
 * menu's button beside the button, a switch beside the toggle — is a review's to catch, not this rule's.
 */
export function kitDuplicateExports(sources: ReadonlyMap<string, string>): UiViolation[] {
  const first = new Map<string, string>();
  const found: UiViolation[] = [];
  for (const file of [...sources.keys()].sort(compare)) {
    for (const entry of kitExports(file, sources.get(file)!)) {
      const owner = first.get(entry.name);
      if (owner === undefined) first.set(entry.name, file);
      else found.push({ rule: 'kit-duplicate-export', file, subject: entry.name, line: entry.line });
    }
  }
  return found;
}

/**
 * Parse TSX, not source-text patterns: comments and ordinary strings are not JSX.
 * Local components are PascalCase function declarations/variables, including
 * memo/forwardRef wrappers. This is a syntax boundary, not a type checker: aliases
 * in other modules and className strings computed elsewhere are not resolved.
 */
export function uiViolations(file: string, source: string): UiViolation[] {
  const kit = file.startsWith('wiki/app/src/components/ui/') && file.endsWith('.tsx') && !/\.(?:test|spec)\.tsx$/.test(file);
  if (!isUiSource(file) && !kit) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const aliases = new Map<string, string>();
  const namespaces = new Set<string>();
  const controls = new Map<string, string>();
  const controlNamespaces = new Set<string>();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (CONTROL_MODULES.test(from)) {
      if (bindings && ts.isNamespaceImport(bindings)) controlNamespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const entry of bindings.elements) {
          const exported = entry.propertyName?.text ?? entry.name.text;
          if ((CONTROL_NAMES as readonly string[]).includes(exported)) controls.set(entry.name.text, exported);
        }
      }
      continue;
    }
    if (!/(?:components\/ui\/|^\.\/)(?:dialog|sheet|navigation)\.js$/.test(from)) continue;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const entry of bindings.elements) aliases.set(entry.name.text, entry.propertyName?.text ?? entry.name.text);
    }
  }
  const constants = new Map<string, ts.Expression>();
  function collect(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  }
  collect(tree);
  const found: UiViolation[] = [];
  const occurrences = new Map<string, number>();
  function add(rule: UiRule, node: ts.Node, subject?: string): void {
    const fingerprint = subject ?? createHash('sha256').update(node.getText(tree).replace(/\s+/g, ' ')).digest('hex').slice(0, 20);
    const key = `${rule}:${fingerprint}`;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    found.push({ rule, file, subject: `${fingerprint}#${occurrence}`, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
  }
  function intrinsic(node: ts.JsxOpeningLikeElement): boolean {
    return ts.isIdentifier(node.tagName) && /^[a-z]/.test(node.tagName.text);
  }
  function containsStyledIntrinsic(node: ts.Node): boolean {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && intrinsic(node) &&
      node.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(tree) === 'className')) return true;
    // A nested callback can render JSX (map/conditional children), but a nested
    // declaration is not part of the outer component's returned tree.
    if (ts.isFunctionDeclaration(node)) return false;
    return ts.forEachChild(node, child => containsStyledIntrinsic(child) || undefined) ?? false;
  }
  function componentName(node: ts.Node): string | undefined {
    if (ts.isFunctionDeclaration(node)) return node.name?.text;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      let parent: ts.Node = node.parent;
      while (ts.isCallExpression(parent) || ts.isParenthesizedExpression(parent)) parent = parent.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    }
    return undefined;
  }
  function returnsStyledJsx(node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction): boolean {
    if (!node.body) return false;
    if (!ts.isBlock(node.body)) return containsStyledIntrinsic(node.body);
    function returns(current: ts.Node): boolean {
      if (ts.isReturnStatement(current)) return current.expression !== undefined && containsStyledIntrinsic(current.expression);
      if (ts.isFunctionLike(current)) return false;
      return ts.forEachChild(current, child => returns(child) || undefined) ?? false;
    }
    return returns(node.body);
  }
  function visit(node: ts.Node): void {
    if (!kit && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
      (node.moduleSpecifier.text === 'styled-components' || node.moduleSpecifier.text.startsWith('styled-components/'))) add('styled-components', node);
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const rawTag = node.tagName.getText(tree);
      const tag = ts.isPropertyAccessExpression(node.tagName) && ts.isIdentifier(node.tagName.expression) && namespaces.has(node.tagName.expression.text)
        ? node.tagName.name.text : aliases.get(rawTag) ?? rawTag;
      if (!kit && ['NavigationLink', 'NavigationGroupTrigger', 'NavigationSubheading'].includes(tag)) {
        const icon = node.attributes.properties.find(attr => ts.isJsxAttribute(attr) && attr.name.getText(tree) === 'icon');
        const value = icon && ts.isJsxAttribute(icon) && icon.initializer && ts.isJsxExpression(icon.initializer) ? icon.initializer.expression : undefined;
        const empty = value && (value.kind === ts.SyntaxKind.NullKeyword || value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.TrueKeyword || (ts.isIdentifier(value) && value.text === 'undefined'));
        if (!icon || !ts.isJsxAttribute(icon) || !icon.initializer || empty) add('sidebar-missing-icon', node);
      }
      if (!kit && intrinsic(node) && RAW_UI_ELEMENTS.has(node.tagName.getText(tree))) add('raw-ui-element', node);
      // The kit's one button has no shape props, and a press is disabled only with the words that say why
      // (madarch-64o5.127, madarch-64o5.123). The names resolve through the import, never the text of a tag; a namespace
      // import names the kit's button as `ui.Button` or `Press.Button`, and the member is the control.
      const namedControl = controls.has(rawTag) ||
        (ts.isPropertyAccessExpression(node.tagName) && ts.isIdentifier(node.tagName.expression) && controlNamespaces.has(node.tagName.expression.text) &&
          (CONTROL_NAMES as readonly string[]).includes(node.tagName.name.text));
      if (!kit && namedControl) {
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue;
          if ((SHAPE_PROPS as readonly string[]).includes(attr.name.getText(tree))) add('button-variant', attr);
        }
        const off = node.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(tree) === 'disabled');
        const why = node.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(tree) === 'disabledReason');
        if (off && !why) add('button-disabled-reason', node);
      }
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) continue;
        if (!kit && attr.name.getText(tree) === 'style') add('inline-style', attr);
        if (attr.name.getText(tree) === 'className' && attr.initializer) {
          let arbitrary = false;
          let scroll = false;
          const inspected = new Set<ts.Node>();
          function inspect(value: ts.Node): void {
            if (inspected.has(value)) return;
            inspected.add(value);
            if (ts.isIdentifier(value)) {
              const initializer = constants.get(value.text);
              if (initializer) inspect(initializer);
            }
            if ((ts.isStringLiteralLike(value) || ts.isTemplateHead(value) || ts.isTemplateMiddle(value) || ts.isTemplateTail(value)) &&
              (/(?:^|\s)[^\s]*\[/.test(value.text) || /(?:^|\s)(?:[\w-]+:)*max-w-(?:prose|xs|sm|md|lg|xl|[2-7]xl)(?=\s|$)/.test(value.text))) arbitrary = true;
            if ((ts.isStringLiteralLike(value) || ts.isTemplateHead(value) || ts.isTemplateMiddle(value) || ts.isTemplateTail(value)) && /(?:^|\s)(?:[\w-]+:)*overflow(?:-y)?-(?:auto|scroll)(?=\s|$)/.test(value.text)) scroll = true;
            ts.forEachChild(value, inspect);
          }
          inspect(attr.initializer);
          if (scroll && ['DialogContent', 'DialogPreview', 'SheetContent', 'DialogPrimitive.Content'].includes(tag)) add('dialog-whole-scroll', node);
          if (!kit && arbitrary) add('arbitrary-tailwind', attr);
        }
      }
    }
    if (!kit && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) {
      const name = componentName(node);
      if (name && /^[A-Z]/.test(name) && returnsStyledJsx(node)) add('local-styled-component', node, name);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found.sort((a, b) => compare(debtKey(a), debtKey(b)));
}

export function scanUi(root: string): UiViolation[] {
  const found: UiViolation[] = [];
  const kit = new Map<string, string>();
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const file = relative(root, path).split('\\').join('/');
        if (isUiSource(file)) found.push(...uiViolations(file, readFileSync(path, 'utf8')));
        else if (file.startsWith('wiki/app/src/components/ui/') && file.endsWith('.tsx')) {
          // A kit file is shown and checked as the kit's own; one name offered by two kit files is two components for
          // one job (madarch-64o5.130), refused by `kitDuplicateExports` after every file is read.
          const source = readFileSync(path, 'utf8');
          kit.set(file, source);
          found.push(...uiViolations(file, source));
        }
      }
    }
  }
  walk(resolve(root, 'wiki/app/src'));
  found.push(...kitDuplicateExports(kit));
  return found.sort((a, b) => compare(debtKey(a), debtKey(b)));
}

export function readUiBaseline(text: string): UiDebt[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || !value.every(entry => entry && typeof entry === 'object' &&
    UI_RULES.includes(entry.rule) && typeof entry.file === 'string' && isUiSource(entry.file) && typeof entry.subject === 'string' &&
    Object.keys(entry).sort().join(',') === 'file,rule,subject')) throw new Error('expected an array of UI debt entries (rule, file, subject)');
  return value as UiDebt[];
}

export function compareUiDebt(found: readonly UiDebt[], listed: readonly UiDebt[]): { added: UiDebt[]; stale: UiDebt[]; duplicated: UiDebt[] } {
  const actual = new Set(found.map(debtKey));
  const accepted = new Set(listed.map(debtKey));
  const seen = new Set<string>();
  return {
    added: found.filter(entry => !accepted.has(debtKey(entry))),
    stale: listed.filter(entry => !actual.has(debtKey(entry))),
    duplicated: listed.filter(entry => { const key = debtKey(entry); const duplicate = seen.has(key); seen.add(key); return duplicate; }),
  };
}

export function renderUiBaseline(found: readonly UiDebt[]): string {
  return JSON.stringify([...found].sort((a, b) => compare(debtKey(a), debtKey(b))).map(({ rule, file, subject }) => ({ rule, file, subject })), null, 2) + '\n';
}
