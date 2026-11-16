/** Decision 0039 items 5, 6 and 29: decoded-string mentions and literal name hints. */
export interface MentionSpan { start: number; end: number }
export interface MentionToken extends MentionSpan { uid: string }
/** A same-named candidate: item 29's `{uid, kind, label, domain}` with the kind's own label beside its name (item 6). */
export interface MentionCandidate { uid: string; kind: string; kindLabel: string; label: string; domain?: string }
export interface MentionName { name: string; candidates: readonly MentionCandidate[] }
export interface MentionHint extends MentionSpan { name: string; candidates: MentionCandidate[] }
/** One hint at its place in the written value: the RFC 6901 pointer to the decoded string it stands in. */
export interface MentionFieldHint extends MentionHint { path: string }

export class MentionTextError extends Error {
  readonly code = 'SCHEMA_INVALID';
  readonly expected = '[[uid:<lowercase hyphenated UUID>]]';
  readonly retryable = false;
  constructor(readonly path: string, readonly start: number, readonly end: number,
    readonly line: number, readonly actual: string) {
    super(`Mention string ${path || '/'}:${line}, code-point ${start}: expected [[uid:<lowercase hyphenated UUID>]]`);
    this.name = 'MentionTextError';
  }
}

function at(chars: readonly string[], index: number, literal: string): boolean {
  return Array.from(literal).every((char, offset) => chars[index + offset] === char);
}

function tokenEnd(chars: readonly string[], start: number): number {
  let end = start + 2;
  while (end < chars.length && !at(chars, end, ']]')) end++;
  return end < chars.length ? end + 2 : chars.length;
}

function isUuid(chars: readonly string[]): boolean {
  if (chars.length !== 36) return false;
  return chars.every((char, index) => {
    if (index === 8 || index === 13 || index === 18 || index === 23) return char === '-';
    return '0123456789abcdef'.includes(char);
  });
}

export function scanMentionText(text: string, path = ''): { tokens: MentionToken[]; excludedSpans: MentionSpan[] } {
  const chars = Array.from(text);
  const tokens: MentionToken[] = [];
  const excludedSpans: MentionSpan[] = [];
  let index = 0;
  let line = 1;
  while (index < chars.length) {
    if (at(chars, index, '\\\\')) { index += 2; continue; }
    if (at(chars, index, '\\[[')) {
      const end = tokenEnd(chars, index + 1);
      excludedSpans.push({ start: index, end });
      for (const char of chars.slice(index, end)) if (char === '\n') line++;
      index = end;
      continue;
    }
    if (at(chars, index, '[[uid')) {
      const end = tokenEnd(chars, index);
      const uid = chars.slice(index + 6, end - 2);
      if (!at(chars, index, '[[uid:') || !at(chars, end - 2, ']]') || !isUuid(uid)) {
        throw new MentionTextError(path, index, end, line, chars.slice(index, end).join(''));
      }
      tokens.push({ uid: uid.join(''), start: index, end });
      excludedSpans.push({ start: index, end });
      index = end;
      continue;
    }
    if (chars[index] === '\n') line++;
    index++;
  }
  return { tokens, excludedSpans };
}

function comparePoints(left: string, right: string): number {
  const a = Array.from(left, char => char.codePointAt(0)!);
  const b = Array.from(right, char => char.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

interface State { next: Map<string, number>; fail: number; output: number[] }

/** Aho–Corasick over exact catalogue names: no case folding, boundaries or guesses. */
export function matchMentionNames(text: string, dictionary: readonly MentionName[]): MentionHint[] {
  const { excludedSpans } = scanMentionText(text);
  const states: State[] = [{ next: new Map(), fail: 0, output: [] }];
  const lengths = dictionary.map(entry => Array.from(entry.name).length);
  for (const [id, entry] of dictionary.entries()) {
    if (!lengths[id]) throw new Error(`Mention dictionary /dictionary/${id}/name:1: name must not be empty`);
    let state = 0;
    for (const char of entry.name) {
      let next = states[state]!.next.get(char);
      if (next === undefined) {
        next = states.length;
        states[state]!.next.set(char, next);
        states.push({ next: new Map(), fail: 0, output: [] });
      }
      state = next;
    }
    states[state]!.output.push(id);
  }
  const queue = [...states[0]!.next.values()];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    for (const [char, next] of states[current]!.next) {
      queue.push(next);
      let fail = states[current]!.fail;
      while (fail && !states[fail]!.next.has(char)) fail = states[fail]!.fail;
      states[next]!.fail = states[fail]!.next.get(char) ?? 0;
      states[next]!.output.push(...states[states[next]!.fail]!.output);
    }
  }
  const hints = new Map<string, MentionHint>();
  let state = 0;
  let index = 0;
  const blocked = new Array<number>(Array.from(text).length + 1).fill(0);
  for (const span of excludedSpans) {
    for (let offset = span.start; offset < span.end; offset++) blocked[offset + 1] = 1;
  }
  for (let offset = 1; offset < blocked.length; offset++) blocked[offset] = blocked[offset]! + blocked[offset - 1]!;
  for (const char of text) {
    while (state && !states[state]!.next.has(char)) state = states[state]!.fail;
    state = states[state]!.next.get(char) ?? 0;
    index++;
    for (const id of states[state]!.output) {
      const start = index - lengths[id]!;
      if (blocked[index]! > blocked[start]!) continue;
      const entry = dictionary[id]!;
      const key = `${start}:${index}`;
      let hint = hints.get(key);
      if (!hint) {
        hint = { name: entry.name, start, end: index, candidates: [] };
        hints.set(key, hint);
      }
      for (const candidate of entry.candidates) {
        if (!hint.candidates.some(item => item.uid === candidate.uid && item.kind === candidate.kind
          && item.kindLabel === candidate.kindLabel && item.label === candidate.label && item.domain === candidate.domain)) hint.candidates.push({ ...candidate });
      }
    }
  }
  const result = [...hints.values()];
  for (const hint of result) hint.candidates.sort((a, b) => comparePoints(a.uid, b.uid)
    || comparePoints(a.kind, b.kind) || comparePoints(a.label, b.label) || comparePoints(a.domain ?? '', b.domain ?? ''));
  return result.sort((a, b) => a.start - b.start || a.end - b.end || comparePoints(a.name, b.name));
}

function pointerSegment(value: string): string {
  let result = '';
  for (const char of value) result += char === '~' ? '~0' : char === '/' ? '~1' : char;
  return result;
}

/** Item 29: RFC 6901 paths address decoded JSON string values, not object keys. */
export function* mentionStrings(value: unknown, path = ''): Generator<{ text: string; path: string }> {
  if (typeof value === 'string') yield { text: value, path };
  else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* mentionStrings(item, `${path}/${index}`);
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value).sort(comparePoints)) {
      yield* mentionStrings((value as Record<string, unknown>)[key], `${path}/${pointerSegment(key)}`);
    }
  }
}
