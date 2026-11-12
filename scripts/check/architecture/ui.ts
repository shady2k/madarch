import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript-api';

/** Native controls and disclosure/table structure belong to components/ui. */
export const RAW_UI_ELEMENTS = new Set([
  'button', 'input', 'select', 'option', 'optgroup', 'textarea', 'label', 'form',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'details', 'summary', 'dialog', 'progress', 'meter',
]);
export const UI_RULES = ['raw-ui-element', 'inline-style', 'styled-components', 'arbitrary-tailwind', 'local-styled-component', 'dialog-whole-scroll', 'sidebar-missing-icon'] as const;
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
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const debtKey = (entry: UiDebt): string => JSON.stringify([entry.rule, entry.file, entry.subject]);

export function isUiSource(file: string): boolean {
  return file.startsWith('wiki/app/src/') && file.endsWith('.tsx') &&
    !file.startsWith('wiki/app/src/components/ui/') &&
    !/(?:^|\/)(?:__tests__|__fixtures__)\//.test(file) && !/\.(?:test|spec)\.tsx$/.test(file);
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
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!/(?:components\/ui\/|^\.\/)(?:dialog|sheet|navigation)\.js$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
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
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const file = relative(root, path).split('\\').join('/');
        if (isUiSource(file) || (file.startsWith('wiki/app/src/components/ui/') && file.endsWith('.tsx'))) found.push(...uiViolations(file, readFileSync(path, 'utf8')));
      }
    }
  }
  walk(resolve(root, 'wiki/app/src'));
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
