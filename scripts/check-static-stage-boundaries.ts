/**
 * The static stage boundary check (decision 0033, "Capability boundaries"): a
 * static stage's `execute` receives one pinned file's bytes and bounded reads
 * of the 0028 graph, and never obtains a whole-tree reader or a
 * repository-wide semantic object.
 *
 * The check is type-aware: it opens the repository's TypeScript project, finds
 * each configured stage's `execute` function (and every local function that
 * function calls), and asks the checker for the type of every identifier in
 * them. A type whose declaration stands in a forbidden module, or whose name is
 * one of the forbidden types, fails the check. A member name the configuration
 * lists as answering a whole repository fails it too, named by the identifier
 * that reached it. Every failure names the stage, the file, the line, the
 * column and the reached symbol.
 *
 * The rules live in `static-stage-boundaries.json` and change only in a commit
 * that carries the owner's decision. There is no per-stage exception: decision
 * 0033, item 5, says no whole-tree reader exists for a static stage to call.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { API } from 'typescript/unstable/sync';
import { SyntaxKind } from 'typescript/unstable/ast';

/**
 * What one stage may reach beyond the boundary. Decision 0033's "The code pass"
 * (amended 2026-11-06) names exactly one stage that reads a tree: the code pass,
 * because the library it runs indexes a tree and not a file. Its allowance is
 * written here as the modules and the members that decision names and nothing
 * else; every other stage holds no allowance at all.
 */
export interface StaticStageAllowance {
  /** Source modules whose types this stage may obtain (the snapshot reader, for the code pass). */
  readonly reads?: readonly string[];
  /** Member names of `wholeRepositoryMembers` this stage may name. */
  readonly members?: readonly string[];
}

export interface StaticStageBoundaryConfig {
  readonly stages: Readonly<Record<string, StaticStageAllowance>>;
  /** Type names a static stage's `execute` may never hold. */
  readonly forbiddenTypes: readonly string[];
  /** Source files or folders a static stage's `execute` may never obtain a type from. */
  readonly forbiddenModules: readonly string[];
  /** Member names that answer a whole repository; no static stage may name one. */
  readonly wholeRepositoryMembers: readonly string[];
}

export interface StaticStageBoundaryFailure {
  /** The stage id the configuration named. */
  readonly stage: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  /** The type or member the stage reached, as the checker named it. */
  readonly reached: string;
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
      // A rule names the modules and the members decision 0033's amendments allow this one
      // stage to reach, and nothing else: a field this check does not read is refused by name.
      const allowance: StaticStageAllowance = rule ?? {};
      for (const key of Object.keys(allowance)) {
        if (key !== 'reads' && key !== 'members') {
          throw new Error(`the static stage boundary check reads ${resolve(root, options.configPath)} and the stage ${JSON.stringify(stagePath)} holds the field ${JSON.stringify(key)}: an allowance names only "reads" (the modules decision 0033 names) and "members" (the members it names), and nothing else (decision 0033, item 5)`);
        }
      }
      const file = project.program.getSourceFile(resolve(root, stagePath));
      if (file === undefined) {
        failures.push({ stage: stagePath, file: resolve(root, stagePath), line: 1, column: 1, reached: stagePath, message: `the static stage boundary check knows no source at this path: the configured stage is not part of the repository's TypeScript project` });
        continue;
      }
      const execute = findExecute(file);
      if (execute === undefined) {
        failures.push({ stage: stagePath, file: resolve(root, stagePath), line: 1, column: 1, reached: 'execute', message: 'the configured static stage declares no `execute` function: the boundary check reads what a unit runs, and the stage it was pointed at holds none' });
        continue;
      }
      visit(stagePath, execute, file, new Set(), allowance);
    }
    return failures;

    function refuse(stage: string, node: any, reached: string, message: string): void {
      const file = node.getSourceFile() as any;
      const at = file.getLineAndCharacterOfPosition(node.getStart(file));
      failures.push({ stage, file: file.fileName, line: at.line + 1, column: at.character + 1, message, reached });
    }

    function findExecute(file: any): any {
      let found: any;
      walkTree(file, (node) => {
        if (found !== undefined) return;
        if (node.kind === SyntaxKind.PropertyAssignment && node.name?.getText(file) === 'execute') found = node.initializer;
      });
      return found;
    }

    function visit(stage: string, node: any, file: any, visited: Set<any>, allowance: StaticStageAllowance): void {
      walkTree(node, (child) => {
        if (child.kind === SyntaxKind.Identifier) {
          const name = child.text as string;
          if (config.wholeRepositoryMembers.includes(name) && !(allowance.members ?? []).includes(name)) {
            refuse(stage, child, name, `the static stage ${JSON.stringify(stage)} names "${name}", which answers a whole repository: a static stage receives one file's bytes and bounded graph queries, and has no whole-tree reader or repository-wide object to call (decision 0033, item 5)`);
          }
          const type = project.checker.getTypeAtLocation(child);
          const forbidden = type === undefined ? undefined : forbiddenOf(type);
          const allowed = forbidden !== undefined && (allowance.reads ?? []).some((module) => forbidden.path !== undefined && matchesModule(forbidden.path, module));
          if (forbidden !== undefined && !allowed) {
            refuse(stage, child, forbidden.name, `the static stage ${JSON.stringify(stage)} obtains ${forbidden.name}${forbidden.path === undefined ? '' : ` from ${forbidden.path}`}, which its static context does not hand it: a static unit reads one file's bytes and bounded graph queries, never a whole-tree reader or a repository-wide object (decision 0033, item 5)`);
          }
          // A local function the execute calls is walked too: a stage does not clean its hands by calling a helper that holds the reader.
          const symbol = project.checker.getSymbolAtLocation(child);
          const declaration = symbol?.declarations?.[0]?.resolve(project);
          if (declaration !== undefined && !visited.has(declaration)) {
            visited.add(declaration);
            if (declaration.kind === SyntaxKind.FunctionDeclaration && declaration.body !== undefined) visit(stage, declaration.body, declaration.getSourceFile(), visited, allowance);
            else if (declaration.kind === SyntaxKind.VariableDeclaration && declaration.initializer !== undefined && isFunction(declaration.initializer)) visit(stage, declaration.initializer, declaration.getSourceFile(), visited, allowance);
          }
        }
      });
    }

    function forbiddenOf(type: any, depth = 0): { name: string; path?: string } | undefined {
      if (depth > 8 || type === undefined) return undefined;
      for (const symbol of [type.getSymbol(), type.getAliasSymbol()]) {
        if (symbol === undefined) continue;
        // The declaration's path is found even where the type's own name is what forbids it: an
        // allowance is written as modules, so a type is allowed or refused by where it is declared.
        const paths = (symbol.declarations ?? []).map((handle: any) => handle.resolve(project)?.getSourceFile().fileName as string | undefined).filter((path: string | undefined): path is string => path !== undefined);
        const forbiddenByModule = paths.find((path) => config.forbiddenModules.some((each) => matchesModule(path, each)));
        if (forbiddenByModule !== undefined) return { name: `"${symbol.name}"`, path: forbiddenByModule };
        if (config.forbiddenTypes.includes(symbol.name)) return { name: `"${symbol.name}"`, ...(paths[0] === undefined ? {} : { path: paths[0] }) };
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
    process.stderr.write(`${failure.file}:${failure.line}:${failure.column}: ${failure.stage}: ${failure.message}\n`);
  }
  process.stderr.write(`the static stage boundary check found ${failures.length} ${failures.length === 1 ? 'violation' : 'violations'} in ${resolve(root, configPath)}\n`);
  return 1;
}

// When run as a script (the package's `check`), the failures decide the exit;
// importing the module from a test leaves the process alone.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
