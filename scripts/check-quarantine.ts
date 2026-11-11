#!/usr/bin/env bun
import { parseSync } from '@swc/core';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface QuarantinedCase { file: string; line: number; task: string; name: string }
type Ast = { type: string; value?: string; span?: { start: number }; callee?: Ast; arguments?: { expression: Ast }[] };
const TASK = /^madarch-[a-z0-9]+(?:\.[0-9]+)*$/;
const identifier = (node: Ast | undefined, name: string): boolean => node?.type === 'Identifier' && node.value === name;
const literal = (node: Ast | undefined): string | undefined => node?.type === 'StringLiteral' ? node.value : undefined;

export function quarantineInventory(root = process.cwd()): QuarantinedCase[] {
  const cases: QuarantinedCase[] = [];
  const errors: string[] = [];
  function files(folder: string): string[] {
    return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
      const path = join(folder, entry.name);
      return entry.isDirectory() ? files(path) : /\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
    });
  }
  for (const path of files(join(root, 'test')).sort()) {
    const source = readFileSync(path, 'utf8');
    const file = relative(root, path);
    const ast = parseSync(source, { syntax: 'typescript', tsx: path.endsWith('.tsx') });
    const line = (node: Ast): number => Buffer.from(source).subarray(0, (node.span?.start ?? 1) - 1).toString().split('\n').length;
    const fail = (node: Ast, message: string): void => { errors.push(`${file}:${line(node)}: ${message}`); };
    function walk(value: unknown, suites: (string | undefined)[], inherited?: string): void {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const item of value) walk(item, suites, inherited); return; }
      const node = value as Ast;
      if (node.type === 'CallExpression') {
        const wrapped = node.callee?.type === 'CallExpression' && identifier(node.callee.callee, 'quarantined') ? node.callee : undefined;
        let task = inherited;
        let registrar = node.callee;
        if (wrapped) {
          const id = literal(wrapped.arguments?.[0]?.expression);
          if (wrapped.arguments?.length !== 2 || !id || !TASK.test(id)) fail(wrapped, 'quarantined requires a literal task matching madarch-[a-z0-9]+(?:\\.[0-9]+)*');
          task = id ?? '';
          registrar = wrapped.arguments?.[1]?.expression;
          if (!['test', 'it', 'describe'].some(name => identifier(registrar, name))) fail(wrapped, 'quarantined registrar must be test, it, or describe');
        } else if (identifier(node.callee, 'quarantined')) {
          fail(node, 'quarantined must immediately register a literal test or describe');
          return;
        }
        const suite = identifier(registrar, 'describe');
        const leaf = identifier(registrar, 'test') || identifier(registrar, 'it');
        if (suite || leaf) {
          const name = literal(node.arguments?.[0]?.expression);
          const names = [...suites, name];
          if (task !== undefined && names.some(name => name === undefined)) fail(node, 'quarantined cases and their parent describes require literal names');
          if (leaf) {
            if (task !== undefined) cases.push({ file, line: line(node), task, name: names.join(' ') });
            return;
          }
          const before = cases.length;
          walk(node.arguments?.[1]?.expression, names, task);
          if (wrapped && cases.length === before) fail(node, 'quarantined describe must contain at least one literal test');
          return;
        }
      }
      for (const child of Object.values(value)) walk(child, suites, inherited);
    }
    walk(ast, []);
  }
  const seen = new Set<string>();
  for (const entry of cases) {
    const key = `${entry.file}:${entry.name}`;
    if (seen.has(key)) errors.push(`${entry.file}:${entry.line}: duplicate quarantined full name ${JSON.stringify(entry.name)}`);
    seen.add(key);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return cases;
}

if (import.meta.main) {
  try {
    const cases = quarantineInventory();
    for (const entry of cases) console.log(`${entry.file}:${entry.line} ${entry.task} ${entry.name}`);
    console.log(`${cases.length} quarantined cases (static inventory; no tracker queries)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
