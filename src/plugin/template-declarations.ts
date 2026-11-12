/** Product Liquid declarations become graph opinions here; page readers consume only structured parts. */
import { posix } from 'node:path';
import { generatedTableName, type GraphContract, type VertexDraft } from '../graph/contract.js';
import { byCodePoint } from '../model/order.js';
import { BLOCK_NAMES, templatePartsOf, type TemplatePart, type TemplateValue, type TemplateCondition } from '../knowledge/template.js';
import type { Finding, KindsManifest } from '../product/manifest/kinds.js';
import type { ProductFileRead, ProductFileSource } from './product-files.js';

export const TEMPLATE_CONTRACT: GraphContract = {
  vertex: [{ name: 'template', table: generatedTableName('template', 'vertex'), key: ['path'], capability: 'manifest',
    fields: [{ name: 'path', type: 'text' }, { name: 'template_parts', type: 'json' }] }], edge: [], dictionary: [],
};

interface Node { type: 'text' | 'attribute' | 'tag' | 'section' | 'if' | 'case' | 'when' | 'else'; value: string; args: string; line: number; file: string; children: Node[] }
class TemplateFailure extends Error {
  constructor(readonly finding: Finding) { super(finding.message); }
}
function refuse(file: string, line: number, message: string): never { throw new TemplateFailure({ file, line, message }); }

/** A strict, deliberately bounded Liquid grammar: unsupported logic is refused, never evaluated with empty page data. */
function parse(text: string, file: string): Node[] {
  const root: Node[] = [];
  const stack: Node[] = [];
  let target = root;
  const restore = (): Node[] => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) return root;
    const branch = parent.children[parent.children.length - 1];
    return (parent.type === 'if' || parent.type === 'case') && (branch?.type === 'else' || branch?.type === 'when') ? branch.children : parent.children;
  };
  let at = 0;
  const lineAt = (offset: number): number => text.slice(0, offset).split('\n').length;
  const add = (type: Node['type'], value: string, args: string, offset: number): Node => {
    const node: Node = { type, value, args, file, line: lineAt(offset), children: [] }; target.push(node); return node;
  };
  while (at < text.length) {
    const found = /{{|{%|{#/.exec(text.slice(at));
    const next = found === null ? text.length : at + found.index;
    if (next > at) add('text', text.slice(at, next), '', at);
    if (found === null) break;
    const open = found[0];
    const close = open === '{{' ? '}}' : open === '{%' ? '%}' : '#}';
    const end = text.indexOf(close, next + 2);
    if (end < 0) refuse(file, lineAt(next), `unclosed ${open} template expression`);
    const inside = text.slice(next + 2, end).trim();
    at = end + 2;
    if (open === '{#') continue;
    if (open === '{{') {
      if (!/^(?:page\.)?[A-Za-z_][\w.-]*$/u.test(inside)) refuse(file, lineAt(next), `unsupported attribute expression: ${inside}`);
      add('attribute', inside.replace(/^page\./u, ''), '', next); continue;
    }
    const match = /^([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/u.exec(inside);
    if (match === null) refuse(file, lineAt(next), `invalid template tag: ${inside}`);
    const name = match[1]!; const args = match[2] ?? '';
    if (name === 'comment') {
      if (args !== '') refuse(file, lineAt(next), 'comment accepts no arguments');
      const finish = /\{%\s*endcomment\s*%\}/gu; finish.lastIndex = at;
      const closed = finish.exec(text);
      if (closed === null) refuse(file, lineAt(next), 'unclosed comment');
      at = finish.lastIndex; continue;
    }
    if (name === 'if' || name === 'case') {
      if (args === '') refuse(file, lineAt(next), `${name} requires an expression`);
      const node = add(name, args, '', next); stack.push(node); target = node.children; continue;
    }
    if (name === 'else' || name === 'when') {
      const held = stack[stack.length - 1];
      if (held === undefined || (held.type !== 'if' && held.type !== 'case')) refuse(file, lineAt(next), `${name} requires an open if or case`);
      if ((name === 'else' && args !== '') || (name === 'when' && held.type !== 'case')) refuse(file, lineAt(next), `invalid ${name} branch`);
      if (held.children.some((node) => node.type === 'else')) refuse(file, lineAt(next), 'a branch follows else');
      target = held.children; const branch = add(name, args, '', next); target = branch.children; continue;
    }
    if (name === 'endif' || name === 'endcase') {
      const held = stack.pop();
      if (args !== '' || held?.type !== (name === 'endif' ? 'if' : 'case')) refuse(file, lineAt(next), `${name} does not match an open condition`);
      target = restore(); continue;
    }
    if (name === 'block') {
      if (!/^[A-Za-z_][\w-]*$/u.test(args)) refuse(file, lineAt(next), 'block requires one section name');
      const node = add('section', args, '', next); stack.push(node); target = node.children; continue;
    }
    if (name === 'endblock') {
      const held = stack.pop();
      if (held?.type !== 'section' || (args !== '' && args !== held.value)) refuse(file, lineAt(next), 'endblock does not match an open block');
      target = restore(); continue;
    }
    if (!(BLOCK_NAMES as readonly string[]).includes(name) && !['layout', 'render', 'include', 'assign'].includes(name)) refuse(file, lineAt(next), `unsupported template tag or unknown block: ${name}`);
    add('tag', name, args, next);
  }
  if (stack.length > 0) refuse(file, stack[stack.length - 1]!.line, `unclosed ${stack[stack.length - 1]!.type} ${stack[stack.length - 1]!.value}`);
  return root;
}

function expression(raw: string, node: Node, env: Readonly<Record<string, TemplateValue>>): TemplateValue {
  // Split only outside quotes: a title may itself contain a pipe or the word append.
  const atoms: string[] = [];
  let start = 0; let quote = '';
  for (let at = 0; at < raw.length; at++) {
    const char = raw[at]!;
    if (char === '\\' && quote !== '') { at++; continue; }
    if (quote !== '') { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char !== '|') continue;
    atoms.push(raw.slice(start, at).trim());
    const filter = /^\|\s*append:\s*/u.exec(raw.slice(at));
    if (filter === null) refuse(node.file, node.line, `unsupported filter: ${raw.slice(at)}`);
    at += filter[0].length - 1; start = at + 1;
  }
  if (atoms.length > 0) return { type: 'concat', values: [...atoms, raw.slice(start).trim()].map((atom) => expression(atom, node, env)) };
  if (/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/u.test(raw)) return raw.slice(1, -1).replace(/\\(.)/gu, '$1');
  if (/^-?\d+(?:\.\d+)?$/u.test(raw)) return raw;
  if (raw === 'true' || raw === 'false' || raw === 'nil' || raw === 'null') refuse(node.file, node.line, `unsupported non-string literal: ${raw}`);
  if (Object.hasOwn(env, raw)) return env[raw]!;
  if (/^page\.[A-Za-z_][\w.-]*$/u.test(raw) || raw === 'lang') return { type: 'attribute', name: raw.replace(/^page\./u, '') };
  return refuse(node.file, node.line, `unsupported expression: ${raw}`);
}
function condition(raw: string, node: Node, env: Readonly<Record<string, TemplateValue>>): TemplateCondition {
  let quote = '';
  for (let at = 0; at < raw.length; at++) {
    const char = raw[at]!;
    if (char === '\\' && quote !== '') { at++; continue; }
    if (quote !== '') { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (raw.slice(at, at + 2) === '==') return { type: 'equal', left: expression(raw.slice(0, at).trim(), node, env), right: expression(raw.slice(at + 2).trim(), node, env) };
  }
  return { type: 'truthy', value: expression(raw, node, env) };
}

function parameters(args: string, node: Node, env: Readonly<Record<string, TemplateValue>>): Record<string, TemplateValue> {
  const result: Record<string, TemplateValue> = {};
  let at = 0;
  const pair = /\s*,?\s*([A-Za-z_][\w-]*)\s*[=:]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,]+)(?=\s|,|$)/uy;
  while (at < args.length) {
    if (args.slice(at).trim() === '') break;
    pair.lastIndex = at; const found = pair.exec(args);
    if (found === null) refuse(node.file, node.line, `invalid parameters: ${args.slice(at)}`);
    const name = found[1]!; const raw = found[2]!;
    if (Object.hasOwn(result, name)) refuse(node.file, node.line, `parameter ${name} is given twice`);
    if (!raw.startsWith('"') && !raw.startsWith("'") && !/^(?:-?\d+(?:\.\d+)?|true|false|lang|page\.[A-Za-z_][\w.-]*)$/u.test(raw) && !Object.hasOwn(env, raw)) refuse(node.file, node.line, `unresolved parameter: ${raw}`);
    result[name] = expression(raw, node, env);
    at = pair.lastIndex;
  }
  return result;
}

function reference(node: Node): { path: string; rest: string } {
    const match = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(?:\s*,?\s*([\s\S]*))?$/u.exec(node.args);
    if (match === null) refuse(node.file, node.line, `${node.value} requires a quoted file path`);
    const raw = match[1]!.slice(1, -1);
    if (raw.includes('\\') || raw.includes('\0') || posix.isAbsolute(raw)) refuse(node.file, node.line, 'template reference must stay within the product repository');
    const path = posix.normalize(posix.join(posix.dirname(node.file), raw));
    if (path === '..' || path.startsWith('../') || path === '.') refuse(node.file, node.line, 'template reference must stay within the product repository');
    return { path, rest: match[2] ?? '' };
  }

function entrypoints(manifest: KindsManifest): string[] {
  return [...new Set([...(manifest.declaredTemplates ?? []), ...[...manifest.kinds.values()].map((kind) => kind.template)])].filter((path) => path !== '').sort(byCodePoint);
}

/** Prefetch through the same grammar before the synchronous interpreter reads a pinned tree. Syntax findings remain its responsibility. */
export async function ensureTemplateDeclarations(files: ProductFileSource, manifest: KindsManifest): Promise<void> {
  const seen = new Set<string>();
  const pending = entrypoints(manifest);
  while (pending.length > 0) {
    const batch = pending.splice(0).filter((path) => !seen.has(path));
    for (const path of batch) seen.add(path);
    await files.ensure(batch);
    for (const path of batch) {
      const text = files.has(path) ? files.text(path) : undefined;
      if (text === undefined) continue;
      try {
        const visit = (nodes: readonly Node[]): void => {
          for (const node of nodes) {
            if (node.type === 'tag' && ['layout', 'include', 'render'].includes(node.value)) {
              const dependency = reference(node).path;
              if (!seen.has(dependency)) pending.push(dependency);
            }
            visit(node.children);
          }
        };
        visit(parse(text, path));
      } catch (error) {
        if (!(error instanceof TemplateFailure)) throw error;
      }
    }
  }
}

/** All named entrypoints and their transitive layout/partial paths, including a missing dependency. */
export function interpretTemplateDeclarations(files: ProductFileRead, manifest: KindsManifest): { vertices: VertexDraft[]; findings: Finding[]; paths: string[] } {
  const paths = new Set<string>();
  const findings: Finding[] = [];
  const vertices: VertexDraft[] = [];
  const cache = new Map<string, Node[]>();
  const assignedNames = new Set<string>();
  const read = (path: string): Node[] => {
    paths.add(path);
    const held = cache.get(path); if (held !== undefined) return held;
    const text = files.has(path) ? files.text(path) : undefined;
    if (text === undefined) refuse(path, 1, 'template file is missing or unreadable');
    const nodes = parse(text, path);
    const collect = (list: readonly Node[]): void => {
      for (const node of list) {
        if (node.type === 'tag' && node.value === 'assign') {
          const name = /^([A-Za-z_][\w]*)\s*=/u.exec(node.args)?.[1]; if (name !== undefined) assignedNames.add(name);
        }
        collect(node.children);
      }
    };
    collect(nodes); cache.set(path, nodes); return nodes;
  };

  type Section = { nodes: Node[]; env: Readonly<Record<string, TemplateValue>>; file: string; line: number };
  const expand = (path: string, env: Readonly<Record<string, TemplateValue>>, inherited: ReadonlyMap<string, Section>, chain: readonly string[]): TemplatePart[] => {
    if (chain.includes(path)) refuse(path, 1, `template dependency cycle: ${[...chain, path].join(' -> ')}`);
    const nodes = read(path); const active = [...chain, path];
    const layouts = nodes.filter((node) => node.type === 'tag' && node.value === 'layout');
    if (layouts.length > 1) refuse(path, layouts[1]!.line, 'a template declares only one layout');
    const sections = new Map<string, Section>();
    for (const node of nodes) if (node.type === 'section') {
      if (sections.has(node.value)) refuse(path, node.line, `block ${node.value} is given twice`);
      sections.set(node.value, { nodes: node.children, env, file: node.file, line: node.line });
    }
    for (const [name, section] of inherited) sections.set(name, section);
    const emit = (list: readonly Node[], scope: Readonly<Record<string, TemplateValue>>, conditional = false): TemplatePart[] => {
      const out: TemplatePart[] = [];
      scope = { ...scope };
      for (const node of list) {
        if (node.type === 'text') out.push({ type: 'text', text: node.value, line: node.line });
        else if (node.type === 'attribute') {
          if (assignedNames.has(node.value) && !Object.hasOwn(scope, node.value)) refuse(node.file, node.line, `assigned variable ${node.value} is outside its supported lexical scope`);
          const append = (value: TemplateValue): void => {
            if (typeof value === 'string') out.push({ type: 'text', text: value, line: node.line });
            else if (value.type === 'attribute') out.push({ type: 'attribute', name: value.name, line: node.line });
            else value.values.forEach(append);
          };
          append(scope[node.value] ?? { type: 'attribute', name: node.value });
        } else if (node.type === 'if') {
          const branch = node.children.findIndex((one) => one.type === 'else');
          out.push({ type: 'conditional', condition: condition(node.value, node, scope), then: emit(branch < 0 ? node.children : node.children.slice(0, branch), scope, true), else: branch < 0 ? [] : emit(node.children[branch]!.children, scope, true), line: node.line });
        } else if (node.type === 'case') {
          let rest: TemplatePart[] = [];
          for (const branch of [...node.children].reverse()) {
            if (branch.type === 'else') rest = emit(branch.children, scope, true);
            else if (branch.type === 'when') rest = [{ type: 'conditional', condition: { type: 'equal', left: expression(node.value, node, scope), right: expression(branch.value, branch, scope) }, then: emit(branch.children, scope, true), else: rest, line: branch.line }];
            else if (branch.type !== 'text' || branch.value.trim() !== '') refuse(branch.file, branch.line, 'case content requires a when branch');
          }
          out.push(...rest);
        } else if (node.type === 'when' || node.type === 'else') refuse(node.file, node.line, 'unexpected conditional branch');
        else if (node.type === 'section') {
          const override = inherited.get(node.value);
          const sectionNodes = override?.nodes ?? node.children;
          const reassigns = (nodes: readonly Node[]): Node | undefined => {
            for (const child of nodes) {
              if (child.type === 'tag' && child.value === 'assign') {
                const name = /^([A-Za-z_][\w]*)\s*=/u.exec(child.args)?.[1];
                if (name !== undefined && Object.hasOwn(scope, name)) return child;
              }
              const found = reassigns(child.children); if (found !== undefined) return found;
            }
            return undefined;
          };
          const mutation = reassigns(sectionNodes);
          if (mutation !== undefined) refuse(mutation.file, mutation.line, 'section reassigns an outer variable: mutable section scope is unsupported');
          out.push(...emit(override?.nodes ?? node.children, override?.env ?? scope, conditional));
        } else if (node.value === 'assign') {
          if (conditional) refuse(node.file, node.line, 'assign inside a conditional requires mutable runtime scope and is unsupported');
          const assignment = /^([A-Za-z_][\w]*)\s*=\s*([\s\S]+)$/u.exec(node.args);
          if (assignment === null) refuse(node.file, node.line, 'assign requires name = expression');
          scope = { ...scope, [assignment[1]!]: expression(assignment[2]!, node, scope) };
        } else if (node.value === 'render' || node.value === 'include') {
          const ref = reference(node); const params = parameters(ref.rest, node, scope);
          const assigned = (nodes: readonly Node[]): Node | undefined => {
            for (const child of nodes) {
              if (child.type === 'tag' && (child.value === 'assign' || child.value === 'include' || child.value === 'layout')) return child;
              const nested = assigned(child.children); if (nested !== undefined) return nested;
            }
            return undefined;
          };
          if (node.value === 'include') {
            const mutation = assigned(read(ref.path));
            if (mutation !== undefined) refuse(mutation.file, mutation.line, 'include with mutable assignment scope is unsupported; use render with explicit parameters');
          }
          out.push(...expand(ref.path, node.value === 'include' ? { ...scope, ...params } : params, new Map(), active));
        } else if (node.value === 'layout') refuse(node.file, node.line, 'layout must be at the template root');
        else out.push({ type: 'block', name: node.value as (typeof BLOCK_NAMES)[number], params: parameters(node.args, node, scope), line: node.line });
      }
      return out;
    };
    if (layouts.length === 0) {
      for (const [name, section] of inherited) if (!nodes.some((node) => node.type === 'section' && node.value === name)) refuse(section.file, section.line, `layout ${path} declares no block ${name}`);
      return emit(nodes, env);
    }
    const layout = layouts[0]!; const ref = reference(layout);
    if (ref.rest !== '') refuse(path, layout.line, 'layout accepts only a file path');
    for (const node of nodes) if (node !== layout && node.type !== 'section' && !(node.type === 'text' && node.value.trim() === '')) refuse(path, node.line, 'content outside a layout block would be discarded');
    return expand(ref.path, env, sections, active);
  };
  const entries = entrypoints(manifest);
  for (const path of entries) {
    try {
      if (posix.isAbsolute(path) || path.split('/').includes('..') || path.includes('\\') || path.includes('\0')) refuse(path, 1, 'template path must stay within the product repository');
      const parts = expand(path, {}, new Map(), []);
      if (templatePartsOf(parts) === undefined) refuse(path, 1, 'expanded template does not satisfy the structured template schema');
      vertices.push({ kind: 'template', key: { path }, values: { template_parts: parts }, producer: 'manifest', producerVersion: '1' });
    } catch (error) {
      if (!(error instanceof TemplateFailure)) throw error;
      if (!findings.some((one) => one.file === error.finding.file && one.line === error.finding.line && one.message === error.finding.message)) findings.push(error.finding);
    }
  }
  return { vertices, findings: findings.sort((a, b) => byCodePoint(a.file, b.file) || a.line - b.line || byCodePoint(a.message, b.message)), paths: [...paths].sort(byCodePoint) };
}
