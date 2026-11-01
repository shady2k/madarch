/**
 * The static stage boundary check (decision 0033, "Capability boundaries"): a
 * static stage's `execute` receives one pinned repository's path-scoped answers
 * and bounded graph reads, and never obtains a whole-tree reader or a
 * repository-wide semantic object.
 *
 * The check is type-aware: it opens the repository's TypeScript project, finds
 * each configured stage's `execute` function (and every local function that
 * function calls), and asks the checker for the type of every identifier in
 * them. A type whose declaration stands in a forbidden module, or whose name is
 * one of the forbidden types, fails the check with the file, line and column.
 * The one whole-repository reading, `repositoryTree()`, is allowed only to the
 * stage the configuration names.
 *
 * The rules live in `static-stage-boundaries.json` and change only in a commit
 * that carries the owner's decision.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { API } from 'typescript/unstable/sync';
import { SyntaxKind } from 'typescript/unstable/ast';

export interface StaticStageBoundaryRule {
  /** The capabilities this stage may use from the static context; every other member is refused. */
  readonly allows?: readonly string[];
}

export interface StaticStageBoundaryConfig {
  readonly stages: Readonly<Record<string, StaticStageBoundaryRule>>;
  /** Type names a static stage's `execute` may never hold. */
  readonly forbiddenTypes: readonly string[];
  /** Source files or folders a static stage's `execute` may never obtain a type from. */
  readonly forbiddenModules: readonly string[];
  /** The static context's members that read a whole repository; only a stage that allows one may name it. */
  readonly wholeRepositoryMembers: readonly string[];
}

export interface StaticStageBoundaryFailure {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

/** The check's failures, in the order the stage files were read and the identifiers walked. */
export function checkStaticStageBoundaries(options: { readonly root: string; readonly configPath: string; readonly tsconfigPath?: string }): readonly StaticStageBoundaryFailure[] {
  const root = resolve(options.root);
  const config = JSON.parse(readFileSync(resolve(root, options.configPath), 'utf8')) as StaticStageBoundaryConfig;
  const api = new API({ cwd: root });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [resolve(root, options.tsconfigPath ?? 'tsconfig.json')] });
    const project = snapshot.getProjects()[0];
    if (project === undefined) throw new Error(`the static stage boundary check opened no TypeScript project for ${resolve(root, options.tsconfigPath ?? 'tsconfig.json')}: the check needs the repository's project to resolve a stage's types`);
    const failures: StaticStageBoundaryFailure[] = [];
    for (const [stagePath, rule] of Object.entries(config.stages)) {
      const file = project.program.getSourceFile(resolve(root, stagePath));
      if (file === undefined) {
        failures.push({ file: resolve(root, stagePath), line: 1, column: 1, message: `the static stage boundary check knows no source at this path: the configured stage is not part of the repository's TypeScript project` });
        continue;
      }
      const execute = findExecute(file);
      if (execute === undefined) {
        failures.push({ file: resolve(root, stagePath), line: 1, column: 1, message: 'the configured static stage declares no `execute` function: the boundary check reads what a unit runs, and the stage it was pointed at holds none' });
        continue;
      }
      visit(execute, file, new Set(), new Set(rule.allows ?? []));
    }
    return failures;

    function refuse(node: any, message: string): void {
      const file = node.getSourceFile() as any;
      const at = file.getLineAndCharacterOfPosition(node.getStart(file));
      failures.push({ file: file.fileName, line: at.line + 1, column: at.character + 1, message });
    }

    function findExecute(file: any): any {
      let found: any;
      walkTree(file, (node) => {
        if (found !== undefined) return;
        if (node.kind === SyntaxKind.PropertyAssignment && node.name?.getText(file) === 'execute') found = node.initializer;
      });
      return found;
    }

    function visit(node: any, file: any, visited: Set<any>, allowed: ReadonlySet<string>): void {
      walkTree(node, (child) => {
        if (child.kind === SyntaxKind.Identifier) {
          const name = child.text as string;
          if (config.wholeRepositoryMembers.includes(name) && !allowed.has(name)) {
            refuse(child, `the static stage names "${name}", which reads the whole repository: this stage's context allows ${allowed.size === 0 ? 'no whole-repository reading' : [...allowed].sort().map((each) => `"${each}"`).join(', ')} (decision 0033)`);
          }
          const type = project.checker.getTypeAtLocation(child);
          const forbidden = type === undefined ? undefined : forbiddenOf(type);
          if (forbidden !== undefined) {
            refuse(child, `the static stage obtains ${forbidden}, which its static context does not hand it: a static unit reads one file's bytes and bounded graph queries, never a whole-tree reader (decision 0033)`);
          }
          // A local function the execute calls is walked too: a stage does not
          // clean its hands by calling a helper that holds the reader.
          const symbol = project.checker.getSymbolAtLocation(child);
          const declaration = symbol?.declarations?.[0]?.resolve(project);
          if (declaration !== undefined && !visited.has(declaration)) {
            visited.add(declaration);
            if (declaration.kind === SyntaxKind.FunctionDeclaration && declaration.body !== undefined) visit(declaration.body, declaration.getSourceFile(), visited, allowed);
            else if (declaration.kind === SyntaxKind.VariableDeclaration && declaration.initializer !== undefined && isFunction(declaration.initializer)) visit(declaration.initializer, declaration.getSourceFile(), visited, allowed);
          }
        }
      });
    }

    function forbiddenOf(type: any, depth = 0): string | undefined {
      if (depth > 8 || type === undefined) return undefined;
      for (const symbol of [type.getSymbol(), type.getAliasSymbol()]) {
        if (symbol === undefined) continue;
        if (config.forbiddenTypes.includes(symbol.name)) return `"${symbol.name}"`;
        for (const handle of symbol.declarations ?? []) {
          const resolved = handle.resolve(project);
          const path = resolved?.getSourceFile().fileName;
          if (path === undefined) continue;
          const module = config.forbiddenModules.find((each) => matchesModule(path, each));
          if (module !== undefined) return `"${symbol.name}" from ${path}`;
        }
      }
      if (type.isUnionType?.() === true || type.isIntersectionType?.() === true) {
        for (const member of type.getTypes()) {
          const found = forbiddenOf(member, depth + 1);
          if (found !== undefined) return found;
        }
      }
      const target = type.isTypeReference?.() === true ? type.getTarget() : undefined;
      return target === undefined ? undefined : forbiddenOf(target, depth + 1);
    }
  } finally {
    api.close();
  }
}

/** Whether a declaration's file stands in a configured module: the file itself or a folder of it. */
function matchesModule(path: string, module: string): boolean {
  const one = path.replaceAll('\\', '/');
  const other = module.replaceAll('\\', '/').replace(/\/+$/, '');
  return one === other || one.endsWith(`/${other}`) || one.includes(`/${other}/`) || one.startsWith(`${other}/`);
}

function isFunction(node: any): boolean {
  return node.kind === SyntaxKind.ArrowFunction || node.kind === SyntaxKind.FunctionExpression;
}

function walkTree(node: any, visit: (node: any) => void): void {
  visit(node);
  node.forEachChild((child: any) => walkTree(child, visit));
}

/** The command line: the repository root (default `.`), the config and the project file. */
function main(argv: readonly string[]): number {
  const args = new Map<string, string>();
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]!;
    if (!arg.startsWith('--')) continue;
    const value = argv[at + 1];
    if (value === undefined) throw new Error(`the static stage boundary check reads ${arg} as a flag with a value, and no value follows it`);
    args.set(arg.slice(2), value);
    at += 1;
  }
  const root = resolve(args.get('root') ?? '.');
  const configPath = args.get('config') ?? 'static-stage-boundaries.json';
  const tsconfigPath = args.get('tsconfig') ?? 'tsconfig.json';
  const failures = checkStaticStageBoundaries({ root, configPath, tsconfigPath });
  if (failures.length === 0) return 0;
  for (const failure of failures) {
    process.stderr.write(`${failure.file}:${failure.line}:${failure.column}: ${failure.message}\n`);
  }
  process.stderr.write(`the static stage boundary check found ${failures.length} ${failures.length === 1 ? 'violation' : 'violations'} in ${resolve(root, configPath)}\n`);
  return 1;
}

// When run as a script (the package's `check`), the failures decide the exit;
// importing the module from a test leaves the process alone.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
