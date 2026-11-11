/** Product text is interpreted by plugins, not by a second reader in the engine.
 * The compiler resolves aliases, member symbols and types. The explicit parser
 * surface catalog also covers pure parsers that accept strings rather than files.
 */
import ts from 'typescript-api';
import { relative, resolve } from 'node:path';
import { moduleSet } from './sources.js';
import { orderedViolations, type ArchitectureViolation } from './violation.js';

const PARSERS: Readonly<Record<string, readonly string[]>> = {
  'src/knowledge/markdown.ts': ['splitFrontMatter', 'readMarkdownEntitiesFrom', 'readBody', 'readStatements'],
  'src/knowledge/doc-tree.ts': ['readDocTree'],
  'src/knowledge/anchors.ts': ['anchorLines', 'documentAnchors', 'findAnchor', 'anchorExtent', 'titleOfAnchor'],
  'src/knowledge/doc-sources.ts': ['documentTitle'],
  'src/knowledge/index/page.ts': ['readIndexedPage'],
  'src/knowledge/template.ts': ['parseTemplate'],
  'src/product-wiki/recommendations.ts': ['withoutFencedCode'],
  'src/knowledge/contract-document.ts': ['contractDocument'],
  'src/knowledge/proto-document.ts': ['protoDocument'],
  'src/knowledge/state-machines.ts': ['stateMachinesOf'],
  'src/knowledge/syntax.ts': ['readSyntaxTree'],
  'src/knowledge/kinds.ts': ['readKinds', 'readKindsFrom', 'parseKinds', 'setKindsLanguage'],
  'src/knowledge/workflows.ts': ['parseWorkflows', 'readWorkflowsFrom'],
  'src/product/contract.ts': ['parseContractText'],
  'src/loop/entities.ts': ['parseQuestion', 'parseCorrection', 'readQuestions', 'readCorrections', 'readQuestionsIn', 'readCorrectionsIn'],
  'src/loop/tasks.ts': ['parseTask', 'readTasks', 'readTasksIn'],
  'src/loop/problem-files.ts': ['readProblemDismissalsIn'],
  'src/product-wiki/documents.ts': ['parseDocument', 'blankFieldLines'],
  'src/product-wiki/questions.ts': ['parseQuestion', 'audienceOf'],
  'src/wiki/documents.ts': ['scanDocument'],
  'src/writer/mentions.ts': ['madarchTargets'],
  'src/writer/sentences.ts': ['groundLinks', 'statementsOf'],
};
const TEXT_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  'src/plugin/product-files.ts': ['text', 'readText'],
  'src/plugin/product-source.ts': ['text'],
  'src/plugin/repository-snapshot.ts': ['read', 'readText'],
  'src/plugin/stored-text.ts': ['content', 'contentsOf', 'contentAt'],
  'src/knowledge/product-files.ts': ['text', 'readText'],
  'src/knowledge/product-source.ts': ['text'],
  'src/knowledge/graph-read.ts': ['content', 'contentsOf', 'contentAt'],
  'src/fill/snapshot.ts': ['read', 'readText'],
  'src/knowledge/index/grounds.ts': ['text'],
};
const TEXT_FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
  'src/plugin/stored-text.ts': ['content', 'contentsOf', 'contentAt', 'fileContent', 'fileContents', 'fileTextAt', 'pluginFileContent', 'pluginFileText', 'storedFileText'],
  'src/graph/records.ts': ['fileContent', 'fileContents', 'fileTextAt', 'storedFileText'],
  'src/graph/plugin-turns.ts': ['pluginFileContent'],
  'src/knowledge/product-files.ts': ['workingTreeFiles', 'snapshotFiles'],
  'src/knowledge/index/grounds.ts': ['gitReader'],
  'src/product/registry-file.ts': ['readRegistryFileSafely'],
};
const PARSER_PACKAGES = new Set(['yaml', 'remark-parse', 'remark-gfm', 'unified', 'protobufjs', 'web-tree-sitter']);
const PARSER_CALLS = new Set(['parse', 'parseDocument', 'parseAllDocuments', 'parseSync']);
const FS_READS = new Set(['readFile', 'readFileSync', 'createReadStream', 'open', 'openSync']);
const PRODUCT_ROOTS = new Set(['productFolder', 'productRoot', 'productDirectory']);
const PRODUCT_PATHS = new Set(['workspace.yaml', 'madarch/kinds.yaml', 'madarch/workflows.yaml', 'docs', 'README.md']);

/** Calls and value dependencies are both checked; a type-only import carries no reader. */
export function productFileReaderViolations(root: string): ArchitectureViolation[] {
  const files = moduleSet(root, ['src']).modules;
  const program = ts.createProgram(files.map((file) => resolve(root, file)), {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true,
    allowJs: true, noEmit: true, types: [],
  });
  const checker = program.getTypeChecker();
  const found = new Map<string, ArchitectureViolation>();
  const pathOf = (source: ts.SourceFile): string => relative(root, source.fileName).split('\\').join('/');
  const unalias = (symbol: ts.Symbol | undefined): ts.Symbol | undefined => {
    const seen = new Set<ts.Symbol>();
    while (symbol && symbol.flags & ts.SymbolFlags.Alias && !seen.has(symbol)) {
      seen.add(symbol); symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol;
  };
  const origin = (symbol: ts.Symbol | undefined): { file: string; name: string }[] => {
    const held = unalias(symbol);
    return (held?.declarations ?? []).map((decl) => ({file: pathOf(decl.getSourceFile()), name: held!.getName()}));
  };
  const catalogued = (symbol: ts.Symbol | undefined): string | undefined => {
    for (const item of origin(symbol)) {
      if (PARSERS[item.file]?.includes(item.name) || TEXT_FUNCTIONS[item.file]?.includes(item.name) || TEXT_MEMBERS[item.file]?.includes(item.name)) return `${item.file}:${item.name}`;
    }
    return undefined;
  };
  const packageOf = (symbol: ts.Symbol | undefined): string | undefined => {
    const held = unalias(symbol);
    for (const decl of held?.declarations ?? []) {
      const path = decl.getSourceFile().fileName.split('\\').join('/');
      const marker = '/node_modules/';
      const tail = path.slice(path.lastIndexOf(marker) + marker.length);
      if (path.includes(marker)) return tail.startsWith('@') ? tail.split('/').slice(0, 2).join('/') : tail.split('/')[0];
      // Node's ambient modules live together in @types/node; inspect the module declaration.
      for (let node: ts.Node | undefined = decl; node; node = node.parent) {
        if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) return node.name.text;
      }
    }
    return undefined;
  };
  const imported = (node: ts.Node): { module: string; name: string } | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    for (const decl of symbol?.declarations ?? []) {
      if (ts.isImportSpecifier(decl) || ts.isNamespaceImport(decl) || ts.isImportClause(decl)) {
        let parent: ts.Node | undefined = decl;
        while (parent && !ts.isImportDeclaration(parent)) parent = parent.parent;
        if (parent && ts.isImportDeclaration(parent) && ts.isStringLiteral(parent.moduleSpecifier)) {
          return { module: parent.moduleSpecifier.text, name: ts.isImportSpecifier(decl) ? (decl.propertyName ?? decl.name).text : '*' };
        }
      }
    }
    return undefined;
  };
  const valueAt = (expr: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isAwaitExpression(expr)) expr = expr.expression;
    return expr;
  };
  // Follow local aliases/initializers, not arbitrary matching words in source text.
  const productPath = (expr: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    expr = valueAt(expr);
    if (seen.has(expr)) return false;
    seen.add(expr);
    if (ts.isStringLiteralLike(expr)) return PRODUCT_PATHS.has(expr.text) || expr.text.startsWith('docs/') || expr.text.startsWith('madarch/');
    if (ts.isIdentifier(expr)) {
      const declarations = checker.getSymbolAtLocation(expr)?.declarations ?? [];
      return declarations.some((decl) => {
        if (ts.isVariableDeclaration(decl) && decl.initializer) return productPath(decl.initializer, seen);
        if (ts.isParameter(decl) && ts.isIdentifier(decl.name)) return PRODUCT_ROOTS.has(decl.name.text);
        return false;
      });
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const type = checker.getTypeAtLocation(expr.expression);
      const product = type.getSymbol()?.getName();
      return expr.name.text === 'folder' && (product === 'ProductIdentity' || product === 'Product' || productPath(expr.expression, seen));
    }
    if (ts.isCallExpression(expr)) return expr.arguments.some((arg) => productPath(arg, seen));
    if (ts.isTemplateExpression(expr)) return PRODUCT_PATHS.has(expr.head.text) || expr.templateSpans.some((span) => productPath(span.expression, seen) || PRODUCT_PATHS.has(span.literal.text));
    if (ts.isBinaryExpression(expr)) return productPath(expr.left, seen) || productPath(expr.right, seen);
    return false;
  };
  const textCallee = (expr: ts.Expression): string | undefined => {
    expr = valueAt(expr);
    const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr);
    const direct = catalogued(symbol);
    if (direct) return direct;
    // Structural type members (including a renamed local interface) resolve to their declaration.
    if (ts.isElementAccessExpression(expr) && expr.argumentExpression && ts.isStringLiteralLike(expr.argumentExpression)) {
      return catalogued(checker.getTypeAtLocation(expr.expression).getProperty(expr.argumentExpression.text));
    }
    if (ts.isIdentifier(expr)) {
      for (const decl of checker.getSymbolAtLocation(expr)?.declarations ?? []) {
        if (ts.isVariableDeclaration(decl) && decl.initializer && decl.initializer !== expr) {
          const held = valueAt(decl.initializer);
          if (ts.isPropertyAccessExpression(held)) return catalogued(checker.getSymbolAtLocation(held.name));
        }
      }
    }
    return undefined;
  };
  const executes = (expression: ts.Expression, seen = new Set<ts.Symbol>()): boolean => {
    expression = valueAt(expression);
    const leaf = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    const symbol = unalias(checker.getSymbolAtLocation(leaf));
    const binding = imported(leaf) ?? (ts.isPropertyAccessExpression(expression) ? imported(expression.expression) : undefined);
    if (binding?.module === 'node:child_process' || binding?.module === 'child_process') return true;
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'Bun' && ['spawn', 'spawnSync'].includes(expression.name.text)) return true;
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    let execution = false;
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && executes(node.expression, seen)) execution = true;
      // promisify(execFile) is the common command runner's initializer.
      if (ts.isIdentifier(node) && imported(node)?.module === 'node:child_process') execution = true;
      ts.forEachChild(node, walk);
    };
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration) && declaration.body) walk(declaration.body);
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) walk(declaration.initializer);
    }
    return execution;
  };
  for (const file of files) {
    if (file.startsWith('src/plugin/') || file === 'src/product/manifest.ts' || ['src/product/manifest/kinds.ts', 'src/product/manifest/workflows.ts', 'src/product/manifest/contract.ts', 'src/product/manifest/registry-file.ts', 'src/product/manifest/fill-config.ts', 'src/product/manifest/registry.ts'].includes(file)) continue;
    const source = program.getSourceFile(resolve(root, file));
    if (!source) throw new Error(`${resolve(root, file)}:1: TypeScript did not load the module`);
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (diagnostics.length) {
      const diagnostic = diagnostics[0]!;
      throw new Error(`${resolve(root, file)}:${source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
    }
    const record = (node: ts.Node, surface: string): void => {
      const symbol = surface;
      const key = `${file}\0${symbol}`;
      if (!found.has(key)) found.set(key, {rule: 'product-file-readers', file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, symbol});
    };
    const visit = (node: ts.Node): void => {
      if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name) && PARSERS[file]?.includes(node.name.text)) record(node, `parser:${file}:${node.name.text}`);
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const names = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((item) => !item.isTypeOnly).map((item) => item.name) : [];
        if (clause?.name) names.push(clause.name);
        if (bindings && ts.isNamespaceImport(bindings)) {
          const module = checker.getSymbolAtLocation(node.moduleSpecifier);
          for (const exported of module ? checker.getExportsOfModule(module) : []) {
            const surface = catalogued(exported);
            if (surface) record(node, `dependency:${surface}`);
          }
        }
        for (const name of names) { const surface = catalogued(checker.getSymbolAtLocation(name)); if (surface) record(node, `dependency:${surface}`); }
        if (PARSER_PACKAGES.has(node.moduleSpecifier.text) && node.moduleSpecifier.text !== 'yaml') record(node, `parser-dependency:${node.moduleSpecifier.text}`);
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const module = checker.getSymbolAtLocation(node.moduleSpecifier);
        const exports = module ? checker.getExportsOfModule(module) : [];
        const names = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements.filter((item) => !item.isTypeOnly).map((item) => (item.propertyName ?? item.name).text) : undefined;
        for (const exported of exports) {
          if (names && !names.includes(exported.getName())) continue;
          const surface = catalogued(exported); if (surface) record(node, `dependency:${surface}`);
        }
      }
      if (ts.isCallExpression(node)) {
        const surface = textCallee(node.expression);
        if (surface) record(node, `call:${surface}`);
        const callee = valueAt(node.expression);
        const leaf = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
        const symbol = unalias(checker.getSymbolAtLocation(leaf));
        const directImport = imported(leaf) ?? (ts.isPropertyAccessExpression(callee) ? imported(callee.expression) : undefined);
        const packageName = directImport?.module ?? packageOf(symbol);
        const name = directImport && directImport.name !== '*' ? directImport.name : symbol?.getName() ?? (directImport && ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined);
        if ((packageName === 'node:fs' || packageName === 'fs' || packageName === 'node:fs/promises' || packageName === 'fs/promises' || packageName === '@types/node') && name && FS_READS.has(name) && node.arguments[0] && productPath(node.arguments[0])) record(node, `filesystem:${name}`);
        if (packageName && PARSER_PACKAGES.has(packageName) && name && PARSER_CALLS.has(name)) {
          // Bundled YAML data imported with {type:'text'} is infrastructure, not product text.
          const input = node.arguments[0];
          const declarations = input && ts.isIdentifier(input) ? checker.getSymbolAtLocation(input)?.declarations ?? [] : [];
          const bundled = declarations.some((decl) => ts.isImportClause(decl) && ts.isImportDeclaration(decl.parent) && decl.parent.attributes !== undefined);
          if (!bundled) record(node, `parser-call:${packageName}:${name}`);
        }
        // Inspect argument ASTs: strings naming git plumbing, never comments or command-like prose.
        const commandWords: string[] = [];
        const words = (part: ts.Node): void => { if (ts.isStringLiteralLike(part)) commandWords.push(part.text); ts.forEachChild(part, words); };
        for (const arg of node.arguments) words(arg);
        if ((commandWords.includes('cat-file') || (commandWords.includes('show') && !commandWords.includes('-s'))) && executes(node.expression)) record(node, 'git:file-text');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return orderedViolations([...found.values()]);
}
