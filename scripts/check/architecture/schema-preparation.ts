/** Schema changes belong to store preparation, never to a runtime store opener. */
import { readFileSync } from 'node:fs';
import { parseSync } from '@swc/core';
import { loadModule, scanSync } from 'libpg-query';
import { moduleNamesOf } from './imports.js';
import { absolutePathOf, moduleSet, resolveModuleSpecifier, type ModuleSet } from './sources.js';
import { orderedViolations, type ArchitectureViolation } from './violation.js';

const PREPARE = 'src/adapters/prepare-store.ts';
const STAMP = 'src/adapters/schema-stamp.ts';
const DEFINITION = 'src/adapters/schemas/graph-definition.ts';
const OWNERS = new Set(['src/adapters/store-preparation-owner.ts', 'src/product/daemon.ts', 'src/product/cli.ts']);

function schema(file: string): boolean {
  return file.startsWith('src/adapters/schemas/');
}

function preparation(file: string): boolean {
  return schema(file) || file === PREPARE || file === STAMP;
}

/** Imports, calls and SQL literals are read from syntax trees, not source-text patterns. */
export async function schemaPreparationViolations(root: string, modules: ModuleSet = moduleSet(root)): Promise<ArchitectureViolation[]> {
  await loadModule();
  const found: ArchitectureViolation[] = [];
  for (const file of modules.modules) {
    const add = (line: number, symbol: string): void => {
      found.push({ rule: 'schema-preparation-only', file, line, symbol });
    };
    const names = moduleNamesOf(root, file);
    for (const statement of names.imports) {
      const target = resolveModuleSpecifier(modules, file, statement.specifier);
      if (target !== null && preparation(target) && target !== DEFINITION) {
        const allowed = target === PREPARE ? OWNERS.has(file) : preparation(file) && file !== DEFINITION;
        if (!allowed) add(statement.line, target);
      } else if (!preparation(file) && statement.names.includes('createSchemaOnce')) {
        add(statement.line, 'createSchemaOnce');
      }
    }
    for (const call of names.literalCalls) {
      const target = resolveModuleSpecifier(modules, file, call.value) ?? (modules.known.has(call.value) ? call.value : null);
      if (target === null || !preparation(target) || target === DEFINITION) continue;
      const allowed = target === PREPARE ? OWNERS.has(file) : preparation(file) && file !== DEFINITION;
      if (!allowed && !names.imports.some((statement) => statement.line === call.line && statement.specifier === call.value)) add(call.line, target);
    }
    const path = absolutePathOf(root, file);
    const source = readFileSync(path, 'utf8');
    const bytes = new TextEncoder().encode(source);
    const lineAt = (offset: number): number => {
      let line = 1;
      for (let index = 0; index < offset - 1; index += 1) if (bytes[index] === 10) line += 1;
      return line;
    };
    let tree;
    try {
      tree = parseSync(source, { syntax: file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.mts') || file.endsWith('.cts') ? 'typescript' : 'ecmascript', tsx: file.endsWith('.tsx'), decorators: true });
    } catch (error) {
      throw new Error(`${path}:1: cannot parse the module for schema preparation: ${(error as Error).message}`);
    }
    const literals: { text: string; start: number }[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) walk(item); return; }
      if (value === null || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      const span = node['span'] as { start: number } | undefined;
      if (node['type'] === 'StringLiteral' && typeof node['value'] === 'string' && span !== undefined) {
        literals.push({ text: node['value'], start: span.start });
      } else if (node['type'] === 'TemplateElement' && span !== undefined) {
        const text = node['cooked'] ?? node['raw'];
        if (typeof text === 'string') literals.push({ text, start: span.start });
      }
      if (!preparation(file) && node['type'] === 'CallExpression') {
        const callee = node['callee'] as Record<string, unknown> | undefined;
        const property = callee?.['property'] as Record<string, unknown> | undefined;
        if (callee?.['value'] === 'createSchemaOnce' || property?.['value'] === 'createSchemaOnce') {
          add(lineAt(span?.start ?? 1), 'createSchemaOnce');
        }
      }
      for (const [key, entry] of Object.entries(node)) if (key !== 'span' && key !== 'ctxt') walk(entry);
    };
    walk(tree);
    if (preparation(file)) continue;
    for (const literal of literals) {
      let tokens;
      try {
        tokens = (scanSync(literal.text).tokens ?? []).filter((token) => token.tokenName !== 'C_COMMENT' && token.tokenName !== 'SQL_COMMENT');
      } catch (error) {
        // Non-SQL prose may not lex as SQL. An apparent DDL fragment must not disappear on a lexer error.
        const first = literal.text.trimStart().split(/\s/u)[0]?.toUpperCase();
        if (first === 'CREATE' || first === 'ALTER' || first === 'DROP') {
          throw new Error(`${path}:${lineAt(literal.start)}: cannot scan SQL for schema preparation: ${(error as Error).message}`);
        }
        continue;
      }
      for (const [index, token] of tokens.entries()) {
        const verb = token.text.toUpperCase();
        if (token.keywordKind === 0 || !['CREATE', 'ALTER', 'DROP'].includes(verb)) continue;
        let next = index + 1;
        while (['OR', 'REPLACE', 'TEMP', 'TEMPORARY', 'UNLOGGED', 'UNIQUE', 'CONCURRENTLY'].includes(tokens[next]?.text.toUpperCase() ?? '')) next += 1;
        const object = tokens[next];
        if (object === undefined || object.keywordKind === 0) continue;
        if (object.text.toUpperCase() === 'DATABASE' && file === 'src/adapters/database-owner.ts') continue;
        const prefix = new TextDecoder().decode(new TextEncoder().encode(literal.text).slice(0, token.start));
        add(lineAt(literal.start) + prefix.split('\n').length - 1, `${verb} ${object.text.toUpperCase()}`);
      }
    }
  }
  const unique = new Map<string, ArchitectureViolation>();
  for (const violation of found) unique.set(`${violation.file}:${violation.line}:${violation.symbol}`, violation);
  return orderedViolations([...unique.values()]);
}
