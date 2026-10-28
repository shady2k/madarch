/**
 * Repository-declared generated and vendored files (mwhd.3, coordinator 08:05Z):
 * the attributes `git` itself would read from `.gitattributes`, parsed here so no
 * consumer of the graph has to recognise a file by its name. A name list in a
 * renderer (lock files by suffix) is a hardcoded fact about other people's
 * repositories; these attributes are declared by the repository itself.
 *
 * The pattern language is `git`'s own, as `.gitattributes(5)` defines it: a
 * pattern without `/` matches a basename at any depth under the file that
 * declares it, a pattern with `/` is anchored to that directory, `**` spans
 * directories, `*` and `?` stop at `/`, `[abc]`/`[!a-z]` match one character and
 * `\` makes the next character literal. Patterns are forbidden to be negative,
 * and — as git documents — a pattern that matches a directory (`dist/`) does not
 * match the paths inside it, so such a pattern marks no file here. A malformed
 * line is a located gap; it never removes a file from the tree.
 *
 * Attributes: `linguist-generated` and `linguist-vendored` with their `-attr`,
 * `!attr`, `attr=false` and `attr=true` forms. Later lines win within a file,
 * a deeper `.gitattributes` overrides a shallower one, and clearing an attribute
 * removes the mark it set.
 */

export type GeneratedReason = 'linguist-generated' | 'linguist-vendored';

export interface GitAttributesGap {
  readonly path: string;
  readonly line: number;
  readonly detail: string;
}

export interface GitAttributesFacts {
  /** Path to the attribute that marks it, for the paths that carry one. */
  readonly generated: ReadonlyMap<string, GeneratedReason>;
  readonly gaps: readonly GitAttributesGap[];
}

type Token = {readonly kind: 'literal'; readonly character: string}
  | {readonly kind: 'any'}
  | {readonly kind: 'one'}
  | {readonly kind: 'class'; readonly spec: string; readonly negated: boolean};

const DECODER = new TextDecoder('utf-8', {fatal: true});

/** Split one line into fields: whitespace separates them, `"` groups, `\` escapes. */
function fieldsOf(line: string): string[] | undefined {
  const fields: string[] = [];
  let at = 0;
  while (at < line.length) {
    while (at < line.length && (line[at] === ' ' || line[at] === '\t')) at += 1;
    if (at >= line.length) break;
    let field = '';
    let quoted = false;
    while (at < line.length) {
      const character = line[at]!;
      if (character === '\\' && at + 1 < line.length) { field += line[at + 1]!; at += 2; continue; }
      if (character === '"') { quoted = !quoted; at += 1; continue; }
      if (!quoted && (character === ' ' || character === '\t')) break;
      field += character; at += 1;
    }
    if (quoted) return undefined;
    if (field === '') return undefined;
    fields.push(field);
  }
  return fields;
}

/** One path segment as tokens; an unclosed class is malformed. */
function tokensOf(segment: string): Token[] | undefined {
  const tokens: Token[] = [];
  for (let at = 0; at < segment.length; at += 1) {
    const character = segment[at]!;
    if (character === '\\') {
      if (at + 1 >= segment.length) return undefined;
      tokens.push({kind: 'literal', character: segment[at + 1]!}); at += 1; continue;
    }
    if (character === '*') { tokens.push({kind: 'any'}); continue; }
    if (character === '?') { tokens.push({kind: 'one'}); continue; }
    if (character === '[') {
      const close = segment.indexOf(']', at + 1);
      if (close < 0) return undefined;
      const raw = segment.slice(at + 1, close);
      const negated = raw.startsWith('!') || raw.startsWith('^');
      const spec = negated ? raw.slice(1) : raw;
      if (spec === '') return undefined;
      tokens.push({kind: 'class', spec, negated}); at = close; continue;
    }
    tokens.push({kind: 'literal', character});
  }
  return tokens;
}

function inClass(spec: string, character: string): boolean {
  for (let at = 0; at < spec.length; at += 1) {
    const low = spec[at]!;
    if (spec[at + 1] === '-' && at + 2 < spec.length) {
      const high = spec[at + 2]!;
      if (low.codePointAt(0)! <= character.codePointAt(0)! && character.codePointAt(0)! <= high.codePointAt(0)!) return true;
      at += 2; continue;
    }
    if (low === character) return true;
  }
  return false;
}

/** `*`, `?` and classes within one segment, with the usual backtracking. */
function matchesSegment(tokens: readonly Token[], text: string): boolean {
  let token = 0; let at = 0; let star = -1; let resume = 0;
  while (at < text.length) {
    const current = tokens[token];
    if (current?.kind === 'any') { star = token; resume = at; token += 1; continue; }
    const character = text[at]!;
    const step = matchesOne(current, character);
    if (step) { token += 1; at += 1; continue; }
    if (star < 0) return false;
    resume += 1; token = star + 1; at = resume;
  }
  while (tokens[token]?.kind === 'any') token += 1;
  return token === tokens.length;
}

function matchesOne(token: Token | undefined, character: string): boolean {
  if (token === undefined) return false;
  if (token.kind === 'one') return true;
  if (token.kind === 'literal') return token.character === character;
  if (token.kind === 'class') return inClass(token.spec, character) !== token.negated;
  return false;
}

function matchesSegments(pattern: readonly (readonly Token[])[] , path: readonly string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern;
  if (head!.length === 1 && head![0]!.kind === 'any') {
    for (let skip = 0; skip <= path.length; skip += 1) if (matchesSegments(rest, path.slice(skip))) return true;
    return false;
  }
  return path.length > 0 && matchesSegment(head!, path[0]!) && matchesSegments(rest, path.slice(1));
}

/** Does this pattern, declared in `directory`, name this path? */
function names(pattern: string, directory: readonly string[], path: readonly string[]): boolean {
  if (pattern.endsWith('/')) return false; // git: a directory pattern does not match the paths inside it
  const anchored = pattern.includes('/');
  const relative = path.slice(directory.length);
  if (!anchored) {
    const basename = path[path.length - 1] ?? '';
    const tokens = tokensOf(pattern);
    return tokens !== undefined && matchesSegment(tokens, basename);
  }
  const body = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  const segments = body.split('/');
  const compiled: (readonly Token[])[] = [];
  for (const segment of segments) {
    if (segment === '**') { compiled.push([{kind: 'any'}]); continue; }
    const tokens = tokensOf(segment);
    if (tokens === undefined) return false;
    compiled.push(tokens);
  }
  return matchesSegments(compiled, relative);
}

function directoriesOf(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1);
}

/**
 * Read every `.gitattributes` of the tree and say which paths it marks.
 * Bytes that are not UTF-8, an unreadable attribute file and a malformed line
 * are located gaps: the tree and its files stay exactly as they were.
 */
export function gitAttributesFacts(tree: {readonly paths: readonly string[]; read(path: string): Uint8Array}): GitAttributesFacts {
  const gaps: GitAttributesGap[] = [];
  const files = tree.paths.filter((path) => (path.split('/').pop() ?? '') === '.gitattributes')
    .map((path) => ({path, directory: directoriesOf(path)}))
    .sort((left, right) => left.directory.length - right.directory.length || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const generated = new Map<string, GeneratedReason>();
  for (const file of files) {
    let text: string;
    try { text = DECODER.decode(tree.read(file.path)); }
    catch { gaps.push({path: file.path, line: 1, detail: 'the attributes file is not UTF-8 text'}); continue; }
    const lines = text.split('\n');
    for (const [index, raw] of lines.entries()) {
      const line = index + 1;
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const fields = fieldsOf(raw);
      if (fields === undefined || fields.length < 2) {
        gaps.push({path: file.path, line, detail: fields === undefined ? 'the attributes line cannot be read' : 'the attributes line names no attribute'});
        continue;
      }
      const [pattern, ...attributes] = fields;
      const body = pattern!.endsWith('/') ? pattern!.slice(0, -1) : pattern!.startsWith('/') ? pattern!.slice(1) : pattern!;
      if (pattern === '' || body.split('/').some((segment) => segment === '' || (segment !== '**' && tokensOf(segment) === undefined))) {
        gaps.push({path: file.path, line, detail: 'the attribute pattern cannot be read'});
        continue;
      }
      for (const path of tree.paths) {
        const parts = path.split('/');
        if (parts.length <= file.directory.length) continue;
        if (!names(pattern!, file.directory, parts)) continue;
        for (const attribute of attributes) {
          const [name, value] = attribute.startsWith('-') || attribute.startsWith('!')
            ? [attribute.slice(1), undefined] : attribute.split('=', 2) as [string, string | undefined];
          if (name !== 'linguist-generated' && name !== 'linguist-vendored') continue;
          if (value === 'false') { if (generated.get(path) === name) generated.delete(path); continue; }
          if (value !== undefined && value !== 'true') continue;
          if (attribute.startsWith('-') || attribute.startsWith('!')) { if (generated.get(path) === name) generated.delete(path); continue; }
          generated.set(path, name);
        }
      }
    }
  }
  return {generated, gaps};
}
