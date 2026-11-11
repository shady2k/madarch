import { parse } from '@babel/parser';

export interface QuarantinedTest {
  readonly name: string;
  readonly task: string;
  readonly reason: string;
  readonly since: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}
interface Node {
  readonly type: string;
  readonly name?: string;
  readonly value?: string;
  readonly callee?: Node;
  readonly arguments?: readonly Node[];
  readonly loc?: { readonly start: { readonly line: number }; readonly end: { readonly line: number } };
}
type Metadata = Pick<QuarantinedTest, 'task' | 'reason' | 'since'>;
const identifier = (node: Node | undefined, name: string): boolean => node?.type === 'Identifier' && node.name === name;
const literal = (node: Node | undefined): string | undefined => node?.type === 'StringLiteral' ? node.value : undefined;

/** Read registrations, not text matches: comments, strings and skipped tests are not quarantine markers. */
export function quarantinedTests(source: string, path: string): QuarantinedTest[] {
  const ast = parse(source, { sourceType: 'unambiguous', plugins: path.endsWith('.tsx') || path.endsWith('.jsx') ? ['typescript', 'jsx'] : ['typescript'] });
  const tests: QuarantinedTest[] = [];
  const fail = (node: Node, message: string): never => { throw new Error(`${path}:${node.loc?.start.line ?? 1}: ${message}`); };
  function walk(value: unknown, suites: readonly (string | undefined)[], inherited?: Metadata): void {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const child of value) walk(child, suites, inherited); return; }
    const node = value as Node;
    if (node.type === 'CallExpression') {
      const marker = node.callee?.type === 'CallExpression' && identifier(node.callee.callee, 'quarantined') ? node.callee : undefined;
      let metadata = inherited;
      let registrar = node.callee;
      if (marker) {
        const [taskNode, registrarNode, reasonNode, sinceNode] = marker.arguments ?? [];
        const task = literal(taskNode);
        const reason = literal(reasonNode);
        const since = literal(sinceNode);
        if (marker.arguments?.length !== 4 || !task || !/^madarch-[a-z0-9]+(?:\.[0-9]+)*$/.test(task)) fail(marker, 'quarantined requires a literal repair task');
        if (!reason || !['slow', 'flaky', 'broken'].includes(reason)) fail(marker, 'quarantined requires a literal reason: slow, flaky, or broken');
        if (!since || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(since)) fail(marker, 'quarantined requires a literal introducing commit hash');
        if (!['test', 'it', 'describe'].some(name => identifier(registrarNode, name))) fail(marker, 'quarantined registrar must be test, it, or describe');
        metadata = { task: task!, reason: reason!, since: since! };
        registrar = registrarNode;
      } else if (identifier(node.callee, 'quarantined')) {
        fail(node, 'quarantined must immediately register a literal test or describe');
      }
      const suite = identifier(registrar, 'describe');
      const leaf = identifier(registrar, 'test') || identifier(registrar, 'it');
      if (suite || leaf) {
        const names = [...suites, literal(node.arguments?.[0])];
        if (metadata && names.some(name => name === undefined)) fail(node, 'quarantined tests and parent describes require literal names');
        if (leaf) {
          if (metadata) tests.push({ ...metadata, name: names.join(' '), lineStart: node.loc!.start.line, lineEnd: node.loc!.end.line });
          return;
        }
        const before = tests.length;
        walk(node.arguments?.[1], names, metadata);
        if (marker && tests.length === before) fail(node, 'quarantined describe must contain a literal test');
        return;
      }
    }
    for (const child of Object.values(value)) walk(child, suites, inherited);
  }
  walk(ast, []);
  const seen = new Set<string>();
  for (const test of tests) {
    if (seen.has(test.name)) throw new Error(`${path}:${test.lineStart}: duplicate quarantined full name ${JSON.stringify(test.name)}`);
    seen.add(test.name);
  }
  return tests;
}
