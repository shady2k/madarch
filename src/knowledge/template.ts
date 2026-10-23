/**
 * A page template (decision 0029): Markdown with `{{attribute}}` substitution
 * and block directives, one per line.
 *
 * ```markdown
 * # {{label}}
 * A {{language}} service.
 * :::related{title="Modules" relation="code.contains" depth=2 kind="code.module"}
 * :::callers
 * ```
 *
 * The engine owns the block library; a template only arranges blocks and text,
 * it holds no logic. A malformed directive, an unknown block and a stray `:::`
 * are findings with the template's file and line, and the page shows them in
 * place of the block, never silently dropped.
 */
import type { Finding } from './kinds.js';

/** The blocks the engine ships. */
export const BLOCK_NAMES = ['body', 'graph', 'related', 'callers', 'callees', 'source', 'er', 'sequence', 'stated', 'implementedby', 'linkedfrom', 'properties', 'children'] as const;
export type BlockName = (typeof BLOCK_NAMES)[number];

export type TemplatePart =
  | { type: 'text'; text: string; line: number }
  | { type: 'block'; name: BlockName; params: Readonly<Record<string, string>>; line: number }
  | { type: 'problem'; message: string; line: number };

const DIRECTIVE = /^:::([A-Za-z][\w-]*)\s*(?:\{(.*)\})?\s*$/;
const PARAM = /\s*,?\s*([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"}]+))/y;

/** Splits a template into text and block parts, keeping each part's first line. */
export function parseTemplate(text: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let buffer: string[] = [];
  let bufferLine = 1;
  const flush = (): void => {
    if (buffer.length > 0) parts.push({ type: 'text', text: buffer.join('\n'), line: bufferLine });
    buffer = [];
  };
  let fence: string | null = null;
  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fenceMark !== null) {
      const run = fenceMark[1]!;
      if (fence === null) fence = run[0]!;
      else if (raw.trim() === run[0]!.repeat(run.length) && fence === run[0]) fence = null;
    }
    if (fence === null && fenceMark === null && raw.startsWith(':::')) {
      flush();
      const match = DIRECTIVE.exec(raw);
      if (match === null) {
        parts.push({ type: 'problem', message: raw.trim() === ':::' ? 'a ":::" line closes nothing: a block is one line, ":::name{parameters}"' : `"${raw.trim()}" is not a block: write ":::name" or ":::name{parameter=value}"`, line });
        return;
      }
      const name = match[1]!;
      if (!(BLOCK_NAMES as readonly string[]).includes(name)) {
        parts.push({ type: 'problem', message: `"${name}" is not a block of the library (${BLOCK_NAMES.join(', ')})`, line });
        return;
      }
      const params = parseParams(match[2] ?? '');
      if (typeof params === 'string') {
        parts.push({ type: 'problem', message: `the parameters of :::${name} are unreadable: ${params}`, line });
        return;
      }
      parts.push({ type: 'block', name: name as BlockName, params, line });
      return;
    }
    if (buffer.length === 0) bufferLine = line;
    buffer.push(raw);
  });
  flush();
  return parts;
}

/** `key=value` and `key="a value"` pairs; a text for a refusal. */
function parseParams(inside: string): Record<string, string> | string {
  const params: Record<string, string> = {};
  let at = 0;
  const trimmed = inside.trim();
  while (at < trimmed.length) {
    PARAM.lastIndex = at;
    const match = PARAM.exec(trimmed);
    if (match === null) return `"${trimmed.slice(at)}" is not name=value`;
    const key = match[1]!;
    if (key in params) return `"${key}" is given twice`;
    params[key] = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3]!;
    at = PARAM.lastIndex;
  }
  return params;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

/** The names a text asks for with `{{name}}`, with their offsets' line within the text. */
export function placeholders(text: string): { name: string; line: number }[] {
  const found: { name: string; line: number }[] = [];
  text.split('\n').forEach((raw, index) => {
    for (const match of raw.matchAll(PLACEHOLDER)) found.push({ name: match[1]!, line: index + 1 });
  });
  return found;
}

/** Escapes what Markdown would read as markup, so an attribute's value is shown as it is. */
export function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]<>()#+!|~]/g, (char) => `\\${char}`).replace(/\n/g, ' ');
}

/**
 * Substitutes `{{name}}` in a text. A name the entity does not hold is shown as
 * an en dash and reported as a finding at the template's file and line, so a
 * typo in a template is seen on the page it breaks.
 */
export function substitute(
  text: string,
  baseLine: number,
  file: string,
  value: (name: string) => string | undefined,
  findings: Finding[],
  options: { escape: boolean } = { escape: true },
): string {
  return text
    .split('\n')
    .map((raw, index) =>
      raw.replace(PLACEHOLDER, (_whole, name: string) => {
        const found = value(name);
        if (found === undefined) {
          findings.push({ file, line: baseLine + index, message: `"{{${name}}}" names no attribute of this entity` });
          return '–';
        }
        return options.escape ? escapeMarkdown(found) : found;
      }),
    )
    .join('\n');
}
