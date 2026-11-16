/** Pure mention grammar and name hints, decision 0039 items 5 and 29. */
export interface MentionOccurrence {
  uid: string;
  path: string;
  start: number;
  end: number;
}

export class MentionSyntaxError extends Error {
  readonly code = 'SCHEMA_INVALID';
  readonly expected = '[[uid:<lowercase hyphenated UUID>]]';
  readonly retryable = false;
  constructor(readonly path: string, readonly start: number, readonly end: number, readonly actual: string) {
    super(`Invalid mention at ${path}, code-point span [${start}, ${end}): expected [[uid:<lowercase hyphenated UUID>]]`);
    this.name = 'MentionSyntaxError';
  }
}

function pointerSegment(value: string): string {
  return Array.from(value, char => char === '~' ? '~0' : char === '/' ? '~1' : char).join('');
}

function codePointOrder(a: string, b: string): number {
  const left = Array.from(a, char => char.codePointAt(0)!);
  const right = Array.from(b, char => char.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return left.length - right.length;
}

function visitStrings(value: unknown, path: string, visit: (text: string, path: string) => void): void {
  if (typeof value === 'string') visit(value, path);
  else if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => visitStrings(item, `${path}/${index}`, visit));
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value).sort(codePointOrder)) {
      visitStrings((value as Record<string, unknown>)[key], `${path}/${pointerSegment(key)}`, visit);
    }
  }
}

function isUuid(value: string): boolean {
  if (value.length !== 36) return false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (char !== '-') return false;
    } else if (!(char >= '0' && char <= '9') && !(char >= 'a' && char <= 'f')) return false;
  }
  return true;
}

interface StringScan { mentions: MentionOccurrence[]; reserved: {start: number; end: number}[] }
function scanString(text: string, path: string): StringScan {
  const chars = Array.from(text);
  const mentions: MentionOccurrence[] = [];
  const reserved: StringScan['reserved'] = [];
  for (let start = 0; start < chars.length;) {
    if (chars[start] === '\\') {
      if (chars[start + 1] === '\\') { start += 2; continue; }
      if (chars[start + 1] === '[' && chars[start + 2] === '[') {
        let end = start + 3;
        while (end < chars.length && !(chars[end] === ']' && chars[end + 1] === ']')) end++;
        end = Math.min(chars.length, end + 2);
        reserved.push({ start, end });
        start = end;
        continue;
      }
      start++;
      continue;
    }
    if (chars.slice(start, start + 5).join('') !== '[[uid') { start++; continue; }
    let end = start + 5;
    while (end < chars.length && !(chars[end] === ']' && chars[end + 1] === ']')) end++;
    end = Math.min(chars.length, end + 2);
    const token = chars.slice(start, end).join('');
    const uid = token.slice(6, -2);
    if (!token.startsWith('[[uid:') || !token.endsWith(']]') || !isUuid(uid)) {
      throw new MentionSyntaxError(path, start, end, token);
    }
    mentions.push({ uid, path, start, end });
    reserved.push({ start, end });
    start = end;
  }
  return { mentions, reserved };
}

/** fieldPath is the field's RFC 6901 pointer; JSON input is already decoded. */
export function scanMentions(value: unknown, fieldPath: string): MentionOccurrence[] {
  const result: MentionOccurrence[] = [];
  visitStrings(value, fieldPath, (text, path) => result.push(...scanString(text, path).mentions));
  return result;
}

export interface MentionCandidate { uid: string; kind: string; label: string; domain: string }
export interface MentionHint { path: string; start: number; end: number; candidates: readonly MentionCandidate[] }

/** Exact catalogue labels/synonyms only: these suggestions never create edges. */
export function scanMentionHints(
  value: unknown,
  fieldPath: string,
  dictionary: ReadonlyMap<string, readonly MentionCandidate[]>,
): MentionHint[] {
  const hints: MentionHint[] = [];
  const names = [...dictionary].sort(([left], [right]) => codePointOrder(left, right));
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  visitStrings(value, fieldPath, (text, path) => {
    const { reserved } = scanString(text, path);
    const chars = Array.from(text);
    const boundaries = new Set<number>([0, chars.length]);
    let offset = 0;
    for (const segment of segmenter.segment(text)) {
      boundaries.add(offset);
      offset += Array.from(segment.segment).length;
      boundaries.add(offset);
    }
    for (let start = 0; start < chars.length; start++) {
      if (!boundaries.has(start)) continue;
      for (const [name, candidates] of names) {
        const length = Array.from(name).length;
        const end = start + length;
        if (!length || !candidates.length || !boundaries.has(end)) continue;
        if (reserved.some(span => start < span.end && end > span.start)) continue;
        if (chars.slice(start, end).join('') === name) hints.push({ path, start, end, candidates });
      }
    }
  });
  return hints;
}
