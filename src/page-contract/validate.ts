/**
 * The template validator (decision 0036, sections 6 and 9): a YAML document judged against a JSON Schema from
 * `schema.ts`, where every finding names the file and the line the offending node stands on, so a product author reads
 * the message beside the key that caused it.
 *
 * The validator walks the YAML document, not the value it parses to: a `yaml` node keeps the range it was read from,
 * and a value has none.
 */
import { isMap, isScalar, isSeq, type Node, type Pair } from 'yaml';

/** One refusal of a template: the file, the 1-based line, the dot path of the node and what is wrong. */
export interface TemplateFinding {
  readonly file: string;
  readonly line: number;
  readonly path: string;
  readonly message: string;
}

type JsonSchema = Readonly<Record<string, unknown>>;

/** The 1-based line a byte offset of the document stands on. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let at = 0; at < offset && at < text.length; at += 1) if (text.charCodeAt(at) === 10) line += 1;
  return line;
}

/** The range start of a node, or the document's own start when the node was made by nobody (a default). */
function startOf(node: Node | null | undefined): number {
  return node?.range?.[0] ?? 0;
}

function typeOfNode(node: Node): string {
  if (isSeq(node)) return 'array';
  if (isMap(node)) return 'object';
  if (isScalar(node)) {
    const value = node.value as unknown;
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    return typeof value;
  }
  return 'null';
}

function matchesType(node: Node, wanted: string): boolean {
  const held = typeOfNode(node);
  if (wanted === 'number') return held === 'number' || held === 'integer';
  return held === wanted;
}

/**
 * One YAML node against one schema from `schema.ts`: the findings name the file and the line the offending node stands on.
 * `path` is the dot path a reader follows to it; the returned findings carry it beside the line.
 */
export function validateNode(text: string, node: Node, schema: JsonSchema, file: string, path = ''): TemplateFinding[] {
  const findings: TemplateFinding[] = [];
  check(node, schema, path, findings, text, file);
  return findings;
}

/** One node against one schema; `path` is the dot path a reader follows to the node. */
function check(node: Node, schema: JsonSchema, path: string, findings: TemplateFinding[], text: string, file: string): void {
  const name = path === '' ? 'the template' : `"${path}"`;
  const oneOf = schema['oneOf'];
  if (Array.isArray(oneOf)) {
    const before = findings.length;
    const attempts: TemplateFinding[][] = oneOf.map((option) => {
      const held: TemplateFinding[] = [];
      check(node, option as JsonSchema, path, held, text, file);
      return held;
    });
    if (attempts.some((held) => held.length === 0)) return;
    // No option fits: the first option's findings stand, and the refusal says the value is none of them.
    findings.push(...attempts[0]!);
    if (findings.length === before) findings.push(finding(text, file, node, path, `${name} is none of the shapes the schema allows`));
    return;
  }
  const wanted = schema['type'];
  if (typeof wanted === 'string' && !matchesType(node, wanted)) {
    findings.push(finding(text, file, node, path, `${name} is ${typeOfNode(node)}; the schema takes ${wanted}`));
    return;
  }
  const values = schema['enum'];
  if (Array.isArray(values)) {
    const value = isScalar(node) ? (node.value as unknown) : undefined;
    if (!values.includes(value)) {
      findings.push(finding(text, file, node, path, `${name} is ${JSON.stringify(value ?? typeOfNode(node))}; the schema takes one of ${values.map((one) => JSON.stringify(one)).join(', ')}`));
      return;
    }
  }
  const pattern = schema['pattern'];
  if (typeof pattern === 'string' && isScalar(node) && typeof node.value === 'string' && !new RegExp(pattern, 'u').test(node.value)) {
    findings.push(finding(text, file, node, path, `${name} is ${JSON.stringify(node.value)}; it does not match ${pattern}`));
    return;
  }
  if (isSeq(node)) {
    const minItems = schema['minItems'];
    if (typeof minItems === 'number' && node.items.length < minItems) {
      findings.push(finding(text, file, node, path, `${name} holds ${String(node.items.length)} entries; it needs at least ${String(minItems)}`));
    }
    const items = schema['items'] as JsonSchema | undefined;
    if (items !== undefined) node.items.forEach((item, at) => check(item as Node, items, path === '' ? String(at) : `${path}.${String(at)}`, findings, text, file));
    return;
  }
  if (isMap(node)) {
    const required = schema['required'];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (keyOf(node, key) === undefined) findings.push(finding(text, file, node, path, `${name} names no "${String(key)}": every template section and file names ${required.map((one) => `"${String(one)}"`).join(', ')}`));
      }
    }
    const minProperties = schema['minProperties'];
    if (typeof minProperties === 'number' && node.items.length < minProperties) findings.push(finding(text, file, node, path, `${name} holds no entry; it needs at least ${String(minProperties)}`));
    const properties = (schema['properties'] ?? {}) as Record<string, JsonSchema>;
    const additional = schema['additionalProperties'];
    for (const pair of node.items as Pair[]) {
      const key = isScalar(pair.key) ? String(pair.key.value) : '';
      const child = pair.value as Node | null;
      const childPath = path === '' ? key : `${path}.${key}`;
      const held = properties[key];
      if (held !== undefined) {
        if (child !== null) check(child, held, childPath, findings, text, file);
        continue;
      }
      if (additional === false) {
        findings.push(finding(text, file, pair.key as Node, childPath, `${name} names "${key}", which the schema does not hold: it takes ${Object.keys(properties).map((one) => `"${one}"`).join(', ')}`));
        continue;
      }
      if (typeof additional === 'object' && additional !== null && child !== null) check(child, additional as JsonSchema, childPath, findings, text, file);
    }
    return;
  }
  // A scalar with no keyword left: nothing to judge.
}

function finding(text: string, file: string, node: Node, path: string, message: string): TemplateFinding {
  return { file, line: lineAt(text, startOf(node)), path, message };
}

function keyOf(node: unknown, key: string): Pair | undefined {
  if (!isMap(node as Node)) return undefined;
  return (node as { items: Pair<unknown, unknown>[] }).items.find((pair) => isScalar(pair.key) && String((pair.key as { value: unknown }).value) === key);
}
