/** Knowledge pages are structured graph opinions. The wiki never interprets product Markdown files. */
import { resolve } from 'node:path';
import { byCodePoint } from '../model/order.js';
import type { Finding, KindsManifest } from '../product/manifest/kinds.js';
import type { GraphReader } from './graph-read.js';
import type { PageStatement } from './index/page.js';

export interface FoundLink { url: string; line: number; ground: boolean }
export interface Statement { text: string; line: number; paragraph: string; notes: string[] }
export interface StatementReading { statements: Statement[]; definitions: Map<string, string[]> }
export interface BodyReading { links: FoundLink[]; findings: Finding[]; ungrounded: { text: string; line: number }[]; statements: number }
export interface MarkdownEntity {
  id: string;
  kind: string;
  title: string;
  relates: string[];
  producer: string | null;
  sources: string[];
  body: string;
  bodyLine: number;
  file: string;
  front: Record<string, unknown>;
  reading: BodyReading;
  statementReading: StatementReading;
  indexedStatements: PageStatement[];
  mentions: string[];
  digest: string;
}

/** Every page opinion of a manifest kind, including all result pages, in code-point order. */
export async function graphMarkdownEntities(graph: Pick<GraphReader, 'list'>, manifest: KindsManifest): Promise<{ entities: MarkdownEntity[]; findings: Finding[] }> {
  const entities: MarkdownEntity[] = [];
  for (const decl of manifest.kinds.values()) {
    let after: string | undefined;
    do {
      const page = await graph.list(decl.name, { limit: 500, ...(after === undefined ? {} : { after }) });
      for (const entity of page.rows) {
        const fields = entity.properties;
        const declared = new Set(decl.fields?.map((field) => field.name));
        const location = `${resolve(typeof fields['file'] === 'string' ? fields['file'] : manifest.file)}:1`;
        const fail = (name: string): never => { throw new Error(`${location}: ${entity.key}.${name}: malformed or missing declared structured graph opinion`); };
        if (typeof fields['body'] !== 'string') {
          if (Object.hasOwn(fields, 'body') || declared.has('body')) fail('body');
          continue;
        }
        for (const name of declared) if (fields[name] === undefined) fail(name);
        const lists = (name: string): string[] => {
          const value = fields[name];
          if (value === undefined) return [];
          if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) fail(name);
          return value as string[];
        };
        const text = (name: string): string => fields[name] === undefined ? '' : typeof fields[name] === 'string' ? fields[name] : fail(name);
        const line = fields['body_line'] ?? 1;
        if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) fail('body_line');
        const records = (name: string): Record<string, unknown>[] => {
          const value = fields[name] ?? [];
          if (!Array.isArray(value) || value.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))) return fail(name);
          return value as Record<string, unknown>[];
        };
        const statements = records('statements').map((statement): PageStatement => {
          for (const name of ['id', 'text', 'digest']) if (typeof statement[name] !== 'string') fail(`statements.${name}`);
          for (const name of ['labels', 'mentions', 'grounds']) if (!Array.isArray(statement[name]) || (statement[name] as unknown[]).some((value) => typeof value !== 'string')) fail(`statements.${name}`);
          if (!Number.isInteger(statement['line']) || (statement['line'] as number) < 1) fail('statements.line');
          if (statement['paragraph'] !== undefined && typeof statement['paragraph'] !== 'string') fail('statements.paragraph');
          return statement as unknown as PageStatement;
        });
        const links = records('links').map((link): FoundLink => {
          if (typeof link['url'] !== 'string' || !Number.isInteger(link['line']) || typeof link['ground'] !== 'boolean') fail('links');
          return link as unknown as FoundLink;
        });
        const findings = records('findings').map((finding): Finding => {
          if (typeof finding['file'] !== 'string' || !Number.isInteger(finding['line']) || typeof finding['message'] !== 'string') fail('findings');
          return finding as unknown as Finding;
        });
        const ungrounded = records('ungrounded').map((statement): { text: string; line: number } => {
          if (typeof statement['text'] !== 'string' || !Number.isInteger(statement['line'])) fail('ungrounded');
          return statement as unknown as { text: string; line: number };
        });
        const producer = fields['producer'] ?? null;
        if (producer !== null && typeof producer !== 'string') fail('producer');
        entities.push({
          id: entity.key, kind: entity.kind, title: entity.label,
          relates: lists('relates'), sources: lists('sources'), producer: producer as string | null,
          body: text('body'), bodyLine: line as number,
          file: text('file'), front: fields,
          reading: { links, findings, ungrounded, statements: statements.length + ungrounded.length },
          statementReading: {
            statements: statements.map((statement) => ({ text: statement.text, line: statement.line, paragraph: statement.paragraph ?? statement.text, notes: [...statement.labels] })),
            definitions: new Map(statements.flatMap((statement) => statement.labels.map((label) => [label, statement.grounds.map((ground) => `madarch:${ground}`)] as [string, string[]]))),
          },
          indexedStatements: statements, mentions: lists('mentions'), digest: text('digest'),
        });
      }
      after = page.next ?? undefined;
    } while (after !== undefined);
  }
  return { entities: entities.sort((a, b) => byCodePoint(a.id, b.id)), findings: [] };
}

const SCHEME = 'madarch:';

/** A `madarch:` target without its scheme; the anchor of a document target is split off. */
export function parseTarget(url: string): { kind: 'key'; key: string } | { kind: 'doc'; path: string; anchor: string | null } {
  let target = url.slice(SCHEME.length);
  try {
    target = decodeURIComponent(target);
  } catch {
    // an escape that does not decode is taken as written; resolution then fails by name
  }
  if (target.startsWith('doc:')) {
    const rest = target.slice('doc:'.length);
    const hash = rest.indexOf('#');
    return hash < 0 ? { kind: 'doc', path: rest, anchor: null } : { kind: 'doc', path: rest.slice(0, hash), anchor: rest.slice(hash + 1) };
  }
  return { kind: 'key', key: target };
}
