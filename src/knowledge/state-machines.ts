/**
 * State machines read out of source text (decision 0026, "Diagrams": a state diagram of an entity with
 * transitions). The graph holds no transition fact, so a state view reads the table a developer writes down: a
 * literal that maps a state to the events it accepts and the state each leads to,
 *
 * ```go
 * var transitions = map[Status]map[Event]Status{ Pending: { Captured: Confirmed } }
 * ```
 *
 * or, in TypeScript, `const transitions = { pending: { captured: 'confirmed' } }` and the adjacency form
 * `{ pending: ['confirmed', 'cancelled'] }`. A table is recognised by its shape and its name (Go: a map of maps
 * named like a table of transitions; TypeScript: a variable named like one), never by a product's own words. Names
 * of constants are resolved to the string they hold when the same file declares them (`Pending Status = "pending"`),
 * and a name the file does not explain stays as written. Every state and every transition carries the line it is
 * written at, so a diagram links back to the code.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { readSyntaxTree } from '../fill/stages/syntax-extract.js';

export interface MachineState {
  /** The name as written in the table. */
  name: string;
  /** What a reader sees: the string the constant holds, else the name. */
  label: string;
  /** 1-based line of its first appearance in the table. */
  line: number;
}

export interface MachineTransition {
  from: string;
  to: string;
  /** The event that moves the entity, when the table names one. */
  event: string | null;
  line: number;
}

export interface StateMachine {
  /** The table's variable name. */
  name: string;
  /** The type the states have (Go), when it is written. */
  type: string | null;
  states: MachineState[];
  transitions: MachineTransition[];
  /** 1-based first and last line of the table. */
  lineStart: number;
  lineEnd: number;
}

type Token = { type: 'name' | 'string' | 'punct'; text: string; line: number };

const NAME_LIKE_TABLE = /(?:transitions?|state[-_ ]?machine|fsm|allowed[-_ ]?(?:moves|transitions)|next[-_ ]?states?)/i;

/** The tokens of a literal: names (dots kept), quoted strings, and the punctuation that shapes it. */
function tokens(text: string, startLine: number): Token[] {
  const out: Token[] = [];
  let line = startLine;
  for (let at = 0; at < text.length; ) {
    const char = text[at]!;
    if (char === '\n') { line += 1; at += 1; continue; }
    if (/\s/.test(char)) { at += 1; continue; }
    if (text.startsWith('//', at)) { while (at < text.length && text[at] !== '\n') at += 1; continue; }
    if (text.startsWith('/*', at)) {
      const end = text.indexOf('*/', at + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (const c of text.slice(at, stop)) if (c === '\n') line += 1;
      at = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      let end = at + 1;
      while (end < text.length && text[end] !== char) end += text[end] === '\\' ? 2 : 1;
      out.push({ type: 'string', text: text.slice(at + 1, end), line });
      for (const c of text.slice(at, end + 1)) if (c === '\n') line += 1;
      at = end + 1;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(text.slice(at));
    if (word !== null) { out.push({ type: 'name', text: word[0], line }); at += word[0].length; continue; }
    out.push({ type: 'punct', text: char, line });
    at += 1;
  }
  return out;
}

type Value = { kind: 'ref'; text: string; line: number } | { kind: 'map'; entries: { key: Token; value: Value }[] } | { kind: 'list'; items: Token[] };

const isPunct = (token: Token | undefined, text: string): boolean => token !== undefined && token.type === 'punct' && token.text === text;

/** The index of the `{` a value starts at, past a Go type in front of it (`map[Event]Status{`, `[]Status{`); undefined when the value is no brace literal. */
function braceAt(list: Token[], at: number): number | undefined {
  for (let cursor = at; cursor < list.length; cursor += 1) {
    const token = list[cursor]!;
    if (isPunct(token, '{')) return cursor;
    if (token.type === 'name' || isPunct(token, '[') || isPunct(token, ']') || isPunct(token, '*')) continue;
    return undefined;
  }
  return undefined;
}

/** Parses the brace literal opened at `open`: a map when its first entry has a key, a list otherwise. */
function parseBrace(list: Token[], open: number): { value: Value; end: number } | undefined {
  const first = list[open + 1];
  const isMap = first !== undefined && ((first.type !== 'punct' && isPunct(list[open + 2], ':')) || (isPunct(first, '[') && isPunct(list[open + 4], ':')));
  const entries: { key: Token; value: Value }[] = [];
  const items: Token[] = [];
  let at = open + 1;
  while (at < list.length) {
    const token = list[at]!;
    if (isPunct(token, '}')) return { value: isMap ? { kind: 'map', entries } : { kind: 'list', items }, end: at + 1 };
    if (isPunct(token, ',')) { at += 1; continue; }
    if (!isMap) {
      if (token.type === 'punct') return undefined;
      items.push(token);
      at += 1;
      continue;
    }
    let key: Token;
    let colon: number;
    if (isPunct(token, '[')) {
      // A computed key (`[Pending]: ...`): the name inside the brackets.
      const inner = list[at + 1];
      if (inner === undefined || inner.type === 'punct' || !isPunct(list[at + 2], ']')) return undefined;
      key = inner;
      colon = at + 3;
    } else if (token.type !== 'punct') {
      key = token;
      colon = at + 1;
    } else return undefined;
    if (!isPunct(list[colon], ':')) return undefined;
    const parsed = valueAt(list, colon + 1);
    if (parsed === undefined) return undefined;
    entries.push({ key, value: parsed.value });
    at = parsed.end;
  }
  return undefined;
}

function valueAt(list: Token[], at: number): { value: Value; end: number } | undefined {
  const token = list[at];
  if (token === undefined) return undefined;
  const open = braceAt(list, at);
  if (open !== undefined) return parseBrace(list, open);
  if (isPunct(token, '[')) {
    const items: Token[] = [];
    let cursor = at + 1;
    while (cursor < list.length && !isPunct(list[cursor], ']')) {
      if (list[cursor]!.type !== 'punct') items.push(list[cursor]!);
      cursor += 1;
    }
    return { value: { kind: 'list', items }, end: cursor + 1 };
  }
  if (token.type === 'name' || token.type === 'string') return { value: { kind: 'ref', text: token.text, line: token.line }, end: at + 1 };
  return undefined;
}

/** Mask comments and string literals without moving offsets or lines. Declarations are matched only in code. */
function declarationText(text: string, go = false): string {
  const chars = text.split('');
  for (let at = 0; at < text.length;) {
    const start = at;
    const char = text[at];
    if (text.startsWith('//', at)) { while (at < text.length && text[at] !== '\n') at++; }
    else if (text.startsWith('/*', at)) { const end = text.indexOf('*/', at + 2); at = end < 0 ? text.length : end + 2; }
    else if (char === '"' || char === "'" || char === '`') {
      at++;
      while (at < text.length && text[at] !== char) at += text[at] === '\\' && !(go && char === '`') ? 2 : 1;
      at = Math.min(text.length, at + 1);
    } else { at++; continue; }
    for (let i = start; i < at; i++) if (text[i] !== '\n' && text[i] !== '\r') chars[i] = ' ';
  }
  return chars.join('');
}

/** Go constants and TypeScript `as const` members that hold a string: name to value. */
function constantsOf(text: string, declarations: string): Map<string, string> {
  const known = new Map<string, string>();
  const inCode = (match: RegExpMatchArray): boolean => declarations.slice(match.index!, match.index! + match[0].indexOf(match[1]!) + match[1]!.length).trim() !== '';
  for (const match of text.matchAll(/^[ \t]*(?:const\s+)?([A-Za-z_]\w*)(?:\s+[A-Za-z_][\w.]*)?\s*=\s*"([^"\n]*)"/gm)) { if (inCode(match)) known.set(match[1]!, match[2]!); }
  // TypeScript objects of string members: `Captured: 'captured'`.
  for (const match of text.matchAll(/^[ \t]*([A-Za-z_]\w*)\s*:\s*['"]([^'"\n]*)['"]\s*,?\s*$/gm)) if (inCode(match) && !known.has(match[1]!)) known.set(match[1]!, match[2]!);
  return known;
}

const bare = (name: string): string => name.slice(name.lastIndexOf('.') + 1);

/**
 * The state machines a source file writes down as transition tables, in the order the file has them. The language is
 * read off the path: `.go` for the Go form, `.ts`, `.tsx`, `.js` and `.mjs` for the TypeScript form.
 */
export async function stateMachinesOf(path: string, text: string): Promise<StateMachine[]> {
  const go = path.endsWith('.go');
  const script = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(path);
  if (!go && !script) return [];
  // The existing grammar understands nested template interpolation, regex literals and JSX. Mask a whole literal,
  // not only its next quote, and keep UTF-16 offsets/newlines so facts still point to their original source lines.
  let scanText = declarationText(text, go);
  if (script) {
    const parsed = await readSyntaxTree(path, new TextEncoder().encode(text), ({ root, complete }) => {
      if (!complete) {
        const locate = (node: SyntaxNode): SyntaxNode | undefined => node.type === 'ERROR' || node.isMissing ? node : node.namedChildren.flatMap(child => child === null ? [] : [locate(child)]).find(child => child !== undefined);
        const invalid = locate(root);
        throw new Error(`${path}:${(invalid?.startPosition.row ?? root.startPosition.row) + 1}: the state declaration reader cannot classify an incomplete syntax tree`);
      }
      const chars = text.split('');
      const visit = (node: SyntaxNode): void => {
        if (['comment', 'string', 'template_string', 'regex', 'jsx_text'].includes(node.type)) {
          for (let at = node.startIndex; at < node.endIndex; at++) if (text[at] !== '\n' && text[at] !== '\r') chars[at] = ' ';
          return;
        }
        for (const child of node.namedChildren) if (child !== null) visit(child);
      };
      visit(root);
      return chars.join('');
    });
    if (!parsed.read) throw new Error(`${path} [state declaration parse]: the state declaration reader could not parse the source: ${JSON.stringify(parsed.unread)}`);
    scanText = parsed.value;
  }
  const constants = constantsOf(text, scanText);
  const found: StateMachine[] = [];
  const header = go
    ? /(?:^|\n)[ \t]*(?:var\s+)?([A-Za-z_]\w*)\s*(?::=|=)\s*map\[([\w.*]+)\]map\[[\w.*]+\]([\w.*]+)\s*\{/g
    : /(?:^|\n)[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*\{/g;
  for (const match of scanText.matchAll(header)) {
    const name = match[1]!;
    if (!NAME_LIKE_TABLE.test(name)) continue;
    const openAt = match.index! + match[0].lastIndexOf('{');
    const before = text.slice(0, openAt);
    const startLine = before.split('\n').length;
    const list = tokens(text.slice(openAt), startLine);
    const parsed = parseBrace(list, 0);
    if (parsed === undefined || parsed.value.kind !== 'map') continue;
    const root = parsed.value;
    const states = new Map<string, MachineState>();
    const transitions: MachineTransition[] = [];
    const state = (token: { text: string; line: number }): void => {
      if (!states.has(token.text)) states.set(token.text, { name: token.text, label: constants.get(bare(token.text)) ?? bare(token.text), line: token.line });
    };
    let shaped = root.entries.length > 0;
    for (const entry of root.entries) {
      const from = entry.key;
      state(from);
      const value = entry.value;
      if (value.kind === 'map') {
        for (const inner of value.entries) {
          if (inner.value.kind !== 'ref') { shaped = false; continue; }
          state({ text: inner.value.text, line: inner.value.line });
          transitions.push({ from: from.text, to: inner.value.text, event: constants.get(bare(inner.key.text)) ?? bare(inner.key.text), line: inner.key.line });
        }
      } else if (value.kind === 'list') {
        for (const item of value.items) {
          state(item);
          transitions.push({ from: from.text, to: item.text, event: null, line: item.line });
        }
      } else shaped = false;
    }
    if (!shaped || transitions.length === 0) continue;
    const lastLine = parsed.end > 0 ? list[parsed.end - 1]!.line : startLine;
    found.push({ name, type: go ? (match[3] ?? null) : null, states: [...states.values()], transitions, lineStart: startLine, lineEnd: lastLine });
  }
  // Go: a string constant of the states may be quoted in the table directly; label them by their text.
  for (const machine of found) for (const entry of machine.states) if (entry.label === entry.name && /^["']/.test(entry.name)) entry.label = entry.name.slice(1, -1);
  return found;
}
