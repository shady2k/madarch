/**
 * Reading a product's identity back from its manifest, and writing the two
 * manifest changes madarch's lifecycle commands make (decision 0021: the
 * product repository format is madarch's published contract; the manifest's
 * schema is the contract's, read by madarch's own code). `workspace.yaml` is
 * how madarch and an agent recognise a product repository: its
 * `schemaVersion`, `id` and `name` are never renamed, and a field this
 * madarch does not know is ignored, so a manifest written by a later
 * madarch still opens.
 *
 * The reader refuses — never defaults, never logs — a folder holding no
 * manifest, a manifest that cannot be read, and a manifest that is not the
 * plain subset of YAML the schema version is written in: block mappings,
 * block sequences of mappings, plain and quoted scalars and comments; an
 * anchor, an alias, a tag, a flow collection, a second document, a duplicate
 * field and an alias standing where a field's name goes are each refused,
 * since a manifest is meant to read the same to a person and to a tool.
 * Beyond the syntax: a schema version this madarch does not know, a missing
 * or empty `id`, a `name` that is not a word, a `skills` field that is not
 * `<set>: <version>` lines, and a `repos` item that names no folder name, no
 * url, or a folder name another item already took — each refusal naming the
 * manifest file and the line where it is known. The words are the contract's
 * conformance cases (`examples/contract/manifest-cases.json`), and the
 * examples' products under `examples/contract/` are folders this reader
 * opens.
 */
import { basename, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

/** The schema version madarch writes and reads; the folder layout is fixed by it alone. */
export const PRODUCT_SCHEMA_VERSION = 1;
/** The manifest's file, at a product folder's root. */
export const MANIFEST_FILE = 'workspace.yaml';

/** One declared code repository of a product's manifest. */
export interface ProductRepo {
  /** The folder under `repos/` the repository is cloned into. */
  name: string;
  /** The optional origin used to clone it; a linked checkout may have none. */
  url?: string;
  /** True when this entry points at an existing local checkout. */
  linked?: boolean;
  /** The branch the clone is taken from, when the manifest declares it. */
  branch?: string;
}

/** The set versions a manifest pins beside the `skills` field, as `<set>: <version>` lines. */
export type ProductSkills = Record<string, string>;

/** A product folder, read: where it is, and the fields that never change. */
export interface ProductIdentity {
  /** The full path of the product folder the manifest was read in. */
  folder: string;
  /** The identifier given at creation; kept for the product's life. */
  id: string;
  /** The product's name: the folder's name for a draft. */
  name: string;
  /** The schema version the manifest was written in. */
  schemaVersion: typeof PRODUCT_SCHEMA_VERSION;
  /** The sets the manifest pins, as `shady2k: <version>` lines; empty when none. */
  skills: ProductSkills;
  /** The code repositories the manifest declares; empty when none. */
  repos: ProductRepo[];
}

/** A refusal: the manifest file, the line where it is known, and the words a reader prints. */
export interface ManifestRefusal {
  ok: false;
  file: string;
  line: number;
  message: string;
}

/** How reading a product folder ended; a refusal names the file and its line. */
export type ProductRead =
  | { ok: true; product: ProductIdentity }
  | ManifestRefusal;

/** A word quoted shell-safely is not needed here; a YAML word is, so the manifest's own quoting is used. */

// ---- the plain subset of YAML the manifest is written in -------------------

/**
 * The line each field of a mapping, and each item of a sequence, was written
 * on: a refusal names the line, so the reader records it as it parses. Kept
 * outside the value itself, so a caller sees plain objects and arrays.
 */
const LINES = new WeakMap<object, unknown>();

/**
 * The line a mapping's field was written on, or 1 when nothing recorded it.
 * The recording is looked for, never assumed: a refusal's line is a courtesy,
 * and a reader that threw where it meant to say "line unknown" would refuse
 * nothing at all.
 */
export function lineOf(value: unknown, key: string): number {
  const map = value !== null && typeof value === 'object' ? LINES.get(value) : undefined;
  return (map instanceof Map ? map.get(key) : undefined) ?? 1;
}

/** The line a sequence's item was written on, or 1 when nothing recorded it. */
export function lineOfIndex(value: unknown, index: number): number {
  const lines = Array.isArray(value) ? LINES.get(value) : undefined;
  return (Array.isArray(lines) ? lines[index] : undefined) ?? 1;
}

/** A refusal in the subset's own shape, for the parse below and its callers. */
const refusal = (file: string, line: number, message: string): ManifestRefusal =>
  ({ ok: false, file, line, message });

/** How one parsed value stands in a message: as YAML would read it back. */
const shown = (value: unknown): string => (value === undefined ? 'nothing' : JSON.stringify(value));

const isItemLine = (content: string): boolean => /^-(\s|$)/.test(content);

/**
 * The manifest's lines, the blank ones and the comment-only ones gone: each
 * kept line with its indentation and its number. Indentation is spaces; a tab
 * in it is refused, since a tab means one thing to one reader and another to
 * the next.
 */
function readLines(text: string, file: string): { ok: true; tokens: { indent: number; content: string; line: number }[] } | ManifestRefusal {
  const kept: { indent: number; content: string; line: number }[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    const body = lines[i]!.replace(/\s+$/, '');
    if (body.trim() === '') continue;
    const indentText = body.match(/^[ \t]*/)![0];
    if (indentText.includes('\t'))
      return refusal(file, line, `the manifest ${file} indents with a tab on line ${line}: a manifest is indented with spaces`);
    const content = body.slice(indentText.length);
    if (content.startsWith('#')) continue;
    if (content === '---' || content === '...' || /^(---|\.\.\.) /.test(content))
      return refusal(file, line, `the manifest ${file} opens another document on line ${line}: a manifest is one document`);
    kept.push({ indent: indentText.length, content, line });
  }
  return { ok: true, tokens: kept };
}

/**
 * A quotation mark opens a quoted scalar where the scalar's text begins, and
 * nowhere else: an apostrophe or a double quote after a plain character has
 * begun is the plain character it is — the name O'Reilly — and it never
 * opens or closes a quoted reading. A quote standing in the token's opening
 * place starts a quoted reading that walks to its own close, escapes and
 * doubled quotes in it, and a `#` inside that reading is the value's own
 * character. Anywhere else a `#` after whitespace or the line's start is
 * where a comment begins.
 */

/**
 * The end of a scalar's text where a comment starts, or the whole of it. A
 * `#` inside a quoted value is the value's own character — a product called
 * `Draft # part` is called that — so quotes are walked, escapes and all.
 */
export function cutComment(text: string): string {
  let quote: string | null = null;
  let tokenStarted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (quote === '"' && ch === '\\') { i++; continue; }
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") { i++; continue; }
        quote = null;
      }
      continue;
    }
    if (ch !== ' ' && ch !== '\t') tokenStarted = true;
    if ((ch === "'" || ch === '"') && onlySpacesBefore(text, i)) { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]!))) return text.slice(0, i);
  }
  return text;
}

/**
 * Whether everything before index i is spaces and tabs: only there does a
 * quote stand in the token's opening place — after any plain character it is
 * that plain character's own, and the token stays plain.
 */
function onlySpacesBefore(text: string, i: number): boolean {
  for (let k = i - 1; k >= 0; k--) {
    if (text[k] !== ' ' && text[k] !== '\t') return false;
  }
  return true;
}

/** The `name: value` split of one line: the part before the first field colon, and after it. */
function splitPair(content: string): { key: string; rest: string } | null {
  let quote: string | null = null;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (quote !== null) {
      if (quote === '"' && ch === '\\') { i++; continue; }
      if (ch === quote) {
        if (quote === "'" && content[i + 1] === "'") { i++; continue; }
        quote = null;
      }
      continue;
    }
    if ((ch === "'" || ch === '"') && onlySpacesBefore(content, i)) { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(content[i - 1]!))) return null;
    if (ch === ':' && (i + 1 === content.length || /\s/.test(content[i + 1]!)))
      return { key: content.slice(0, i), rest: content.slice(i + 1).trim() };
  }
  return null;
}

type Parsed<T> = { ok: true; value: T } | ManifestRefusal;

/**
 * A quoted scalar: single quotes with `''` for a quote, double quotes with the
 * usual escapes. What stands after the closing quote is refused rather than
 * silently dropped.
 */
function unquote(text: string, file: string, line: number): Parsed<unknown> {
  const quote = text[0] as string;
  let out = '';
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === quote) {
      if (quote === "'" && text[i + 1] === "'") { out += "'"; i++; continue; }
      const rest = cutComment(text.slice(i + 1)).trim();
      if (rest !== '')
        return refusal(file, line, `the manifest ${file} holds "${rest}" after the quoted value on line ${line}: a quoted value ends the field`);
      return { ok: true, value: out };
    }
    if (quote === '"' && ch === '\\') {
      const next = text[i + 1];
      const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0' };
      if (next === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex))
          return refusal(file, line, `the manifest ${file} holds an escape on line ${line} that is not \\uXXXX: only the usual escapes are written`);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 5;
        continue;
      }
      if (next === undefined || !(next in escapes))
        return refusal(file, line, `the manifest ${file} holds the escape "\\${next ?? ''}" on line ${line}: only the usual escapes are written`);
      out += escapes[next]!;
      i++;
      continue;
    }
    out += ch;
  }
  return refusal(file, line, `the manifest ${file} opens a quote on line ${line} and never closes it: close it on the same line`);
}

/** The indicators this subset does not take, and what each is called. */
const INDICATORS: Record<string, string> = {
  '&': 'anchor',
  '*': 'alias',
  '!': 'tag',
  // A block scalar holds its value on the lines under it; a `?` key names
  // its field anywhere but "name: value"'s own place. Both are outside the
  // subset: a manifest reads the same to a person and to a tool, one value
  // per field, written plainly.
  '|': 'block scalar literal',
  '>': 'block scalar folded',
  '?': 'complex mapping key',
};

/**
 * What each refused indicator is called, and why the subset refuses it: an
 * anchor, an alias and a tag stand for data elsewhere; a block scalar holds
 * its value on many lines; a complex key names its field anywhere but at
 * "name: value"'s own place.
 */
const INDICATOR_WHY: Record<string, string> = {
  '&': 'an anchor, an alias and a tag are not part of the subset this reader takes',
  '*': 'an anchor, an alias and a tag are not part of the subset this reader takes',
  '!': 'an anchor, an alias and a tag are not part of the subset this reader takes',
  '|': 'a value is written plain or quoted on its own line',
  '>': 'a value is written plain or quoted on its own line',
  '?': 'a field is written "name: value", its key its own plain or quoted word',
};

/** A scalar: plain, quoted, and nothing else this subset takes. */
export function parseScalar(text: string, file: string, line: number): Parsed<unknown> {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  const first = trimmed[0]!;
  if (INDICATORS[first] !== undefined)
    return refusal(file, line, `the manifest ${file} writes the ${INDICATORS[first]} "${trimmed}" on line ${line}: ${INDICATOR_WHY[first]}`);
  if (first === '{' || first === '[' || first === ']' || first === '}')
    return refusal(file, line, `the manifest ${file} writes the flow collection "${trimmed}" on line ${line}: fields are block mappings and block sequences of mappings, one per line`);
  if (first === "'" || first === '"') return unquote(trimmed, file, line);
  const plain = cutComment(trimmed).trim();
  // The words YAML reads as another value, in every spelling YAML reads them
  // in: `null`, `Null` and `~` are nothing, `true` and `True` are a truth.
  if (plain === '' || /^(null|~)$/i.test(plain)) return { ok: true, value: null };
  if (/^(true|false)$/i.test(plain)) return { ok: true, value: plain.toLowerCase() === 'true' };
  if (/:\s/.test(plain) || plain.endsWith(':'))
    return refusal(file, line, `the manifest ${file} holds "${plain}" on line ${line}: a value holding ": " is a mapping written on one line, and this reader takes a mapping one field per line`);
  if (/^[+-]?\d+$/.test(plain)) return { ok: true, value: Number(plain) };
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(plain)) return { ok: true, value: Number(plain) };
  return { ok: true, value: plain };
}

type ParsedBlock = { ok: true; value: unknown; i: number } | ManifestRefusal;

/** A field's name: a word, or a quoted one. An alias never stands in its place. */
function parseKey(text: string, file: string, line: number): Parsed<unknown> {
  const trimmed = text.trim();
  // Nothing stands here: the field's own name is missing. The plain path below
  // refuses it too, so this reader says it once, where it reads.
  const first = trimmed[0] as string | undefined;
  if (first === '*')
    return refusal(file, line, `the manifest ${file} stands the alias "${trimmed}" in a mapping key's place on line ${line}: a field is named by its own word, never by an alias`);
  if (first !== undefined && INDICATORS[first] !== undefined)
    return refusal(file, line, `the manifest ${file} writes the ${INDICATORS[first]} "${trimmed}" where a field's name goes, on line ${line}: a field is named by its own word`);
  if (first === '{' || first === '[')
    return refusal(file, line, `the manifest ${file} writes the flow collection "${trimmed}" where a field's name goes, on line ${line}: fields are block mappings, one per line`);
  if (first === "'" || first === '"') {
    const quoted = unquote(trimmed, file, line);
    if (!quoted.ok) return quoted;
    if (typeof quoted.value !== 'string' || quoted.value === '')
      return refusal(file, line, `the manifest ${file} holds ${shown(quoted.value)} where a field's name goes, on line ${line}: a field is named by a word`);
    return { ok: true, value: quoted.value };
  }
  const plain = cutComment(trimmed).trim();
  if (plain === '')
    return refusal(file, line, `the manifest ${file} writes a field with no name on line ${line}: a field is written "name: value"`);
  return { ok: true, value: plain };
}

type Token = { indent: number; content: string; line: number };

/** A block mapping at one indentation, its fields in the order they were written. */
function parseMapping(tokens: Token[], i: number, indent: number, file: string): ParsedBlock {
  // Without a prototype: a manifest naming `__proto__` writes a field like
  // any other, and reading it never reaches an inherited `schemaVersion` or
  // `id` — an identity a manifest cannot hold is one it must not be read as.
  const value: Record<string, unknown> = Object.create(null);
  const positions = new Map<string, number>();
  while (i < tokens.length && tokens[i]!.indent === indent && !isItemLine(tokens[i]!.content)) {
    const token = tokens[i]!;
    const pair = splitPair(token.content);
    if (pair === null)
      return refusal(file, token.line, `the manifest ${file} holds line ${token.line}, which is neither a field "name: value" nor a list item "- ...": a manifest is a block mapping of fields`);
    const key = parseKey(pair.key, file, token.line);
    if (!key.ok) return key;
    const keyWord = key.value as string;
    if (positions.has(keyWord))
      return refusal(file, token.line, `the manifest ${file} names "${keyWord}" twice, again on line ${token.line}: each field is given once`);
    positions.set(keyWord, token.line);
    // `field: # a comment` is a field with no value on its line: what stands
    // indented under it is its block, and the comment is not the value.
    if (cutComment(pair.rest).trim() === '') {
      if (i + 1 < tokens.length && tokens[i + 1]!.indent > indent) {
        const sub = parseBlock(tokens, i + 1, tokens[i + 1]!.indent, file);
        if (!sub.ok) return sub;
        value[keyWord] = sub.value;
        i = sub.i;
      } else {
        value[keyWord] = null;
        i++;
      }
      continue;
    }
    const scalar = parseScalar(pair.rest, file, token.line);
    if (!scalar.ok) return scalar;
    value[keyWord] = scalar.value;
    i++;
    if (i < tokens.length && tokens[i]!.indent > indent)
      return refusal(file, tokens[i]!.line, `the manifest ${file} indents line ${tokens[i]!.line} under "${keyWord}", which already holds ${shown(scalar.value)}: a field holds one value`);
  }
  LINES.set(value, positions);
  return { ok: true, value, i };
}

/** A block sequence at one indentation: scalars, or mappings starting on the dash's own line. */
function parseSequence(tokens: Token[], i: number, indent: number, file: string): ParsedBlock {
  const items: unknown[] = [];
  const lines: number[] = [];
  while (i < tokens.length && tokens[i]!.indent === indent && isItemLine(tokens[i]!.content)) {
    const token = tokens[i]!;
    // What follows the dash, every one of its own spaces and tabs taken off:
    // those spaces are the item's own deeper indentation, the column the
    // item's first word stands at — `-   name: api` writes its fields under
    // that same column, and the item's block reads from there.
    const afterDash = token.content.slice(1);
    const itemIndent = indent + 1 + (afterDash.length - afterDash.replace(/^[ \t]*/, '').length);
    const onDash = afterDash.replace(/^[ \t]*/, '');
    const visible = cutComment(onDash).trim();
    if (visible === '') {
      // A bare dash, or one whose line carries only a comment: the item is
      // what stands indented under it, or nothing.
      if (i + 1 < tokens.length && tokens[i + 1]!.indent > indent) {
        const sub = parseBlock(tokens, i + 1, tokens[i + 1]!.indent, file);
        if (!sub.ok) return sub;
        items.push(sub.value);
        i = sub.i;
      } else {
        items.push(null);
        i++;
      }
    } else {
      const sub: Token[] = [{ indent: itemIndent, content: onDash, line: token.line }];
      let j = i + 1;
      while (j < tokens.length && tokens[j]!.indent > indent) { sub.push(tokens[j]!); j++; }
      const parsed = parseBlock(sub, 0, itemIndent, file);
      if (!parsed.ok) return parsed;
      if (parsed.i < sub.length)
        return refusal(file, sub[parsed.i]!.line, `the manifest ${file} indents line ${sub[parsed.i]!.line} under an item that already holds a value: a list item holds one value`);
      items.push(parsed.value);
      i = j;
    }
    lines.push(token.line);
  }
  LINES.set(items, lines);
  return { ok: true, value: items, i };
}

/** One block at one indentation: a mapping, a sequence, or a lone scalar. */
function parseBlock(tokens: Token[], i: number, indent: number, file: string): ParsedBlock {
  if (isItemLine(tokens[i]!.content)) return parseSequence(tokens, i, indent, file);
  if (splitPair(tokens[i]!.content) !== null) return parseMapping(tokens, i, indent, file);
  const scalar = parseScalar(tokens[i]!.content, file, tokens[i]!.line);
  if (!scalar.ok) return scalar;
  return { ok: true, value: scalar.value, i: i + 1 };
}

/**
 * A whole manifest's text, read as the subset above: the value, or the first
 * refusal with the line it stands on. The entry the reader and the writing
 * helpers share, exported for the contract's check command and the tests.
 */
export function parseManifest(text: string, file: string): { ok: true; value: unknown } | ManifestRefusal {
  const read = readLines(text, file);
  if (!read.ok) return read;
  const tokens = read.tokens;
  if (!tokens.length)
    return refusal(file, 1, `the manifest ${file} is empty: a product is recognised by its schemaVersion, its id and its name`);
  if (tokens[0]!.indent !== 0)
    return refusal(file, tokens[0]!.line, `the manifest ${file} indents its first line by ${tokens[0]!.indent} spaces: a manifest starts at the left margin`);
  const parsed = parseBlock(tokens, 0, 0, file);
  if (!parsed.ok) return parsed;
  if (parsed.i < tokens.length)
    return refusal(file, tokens[parsed.i]!.line, `the manifest ${file} holds line ${tokens[parsed.i]!.line} at a place of its own: a field holds one value, and a value's lines are indented under it`);
  return { ok: true, value: parsed.value };
}

/** A folder name a code repository may take: one path segment, and nothing that moves. */
export function isFolderName(name: unknown): name is string {
  return typeof name === 'string' && name !== '' && name === name.trim()
    && name !== '.' && name !== '..' && !/[/\\\u0000-\u001f]/.test(name);
}

// ---- a product, read from its manifest -------------------------------------

/**
 * Reads one product folder's manifest. Refused — never defaulted, never
 * logged — when the folder holds no manifest, the manifest cannot be read or
 * is not the subset above, names no schema version this madarch knows, names
 * no `id`, or names a `skills` or `repos` field this madarch cannot use. A
 * field this madarch does not know is ignored: a manifest grows by fields
 * added beside the three.
 *
 * The product it returns carries where it was read (the folder's full path),
 * the three fields that are never renamed, and the fields a caller needs to
 * work with the code repositories: `skills` and `repos`.
 */
export function readProduct(productFolder: string): ProductRead {
  const folder = resolve(productFolder);
  const manifestFile = join(folder, MANIFEST_FILE);

  let text: string;
  try {
    text = readFileSync(manifestFile, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT')
      return refusal(manifestFile, 1, `the folder ${folder} holds no ${MANIFEST_FILE}: a product is recognised by its manifest`);
    return refusal(manifestFile, 1, `the manifest ${manifestFile} could not be read: ${(error as Error).message}`);
  }

  const parsed = parseManifest(text, manifestFile);
  if (!parsed.ok) return parsed;
  const record = parsed.value;
  if (record === null || typeof record !== 'object' || Array.isArray(record))
    return refusal(manifestFile, 1, `the manifest ${manifestFile} holds ${shown(record)}: a manifest is a mapping of fields, and this is not one`);
  const fields = record as Record<string, unknown>;

  if (!('schemaVersion' in fields))
    return refusal(manifestFile, 1, `the manifest ${manifestFile} names no "schemaVersion": a product knows version ${PRODUCT_SCHEMA_VERSION}`);
  if (typeof fields.schemaVersion !== 'number' || fields.schemaVersion !== PRODUCT_SCHEMA_VERSION)
    return refusal(manifestFile, lineOf(fields, 'schemaVersion'), `the manifest ${manifestFile} holds ${shown(fields.schemaVersion)} at "schemaVersion": not a schema version this program knows; it writes ${PRODUCT_SCHEMA_VERSION}`);

  if (!('id' in fields))
    return refusal(manifestFile, 1, `the manifest ${manifestFile} names no "id": a product is identified by the id it was given at creation`);
  if (typeof fields.id !== 'string' || fields.id.trim() === '')
    return refusal(manifestFile, lineOf(fields, 'id'), `the manifest ${manifestFile} holds ${shown(fields.id)} at "id": a product is identified by the id it was given at creation, and it is a word`);

  let name: string;
  if (fields.name === undefined || fields.name === '') name = basename(folder.replace(/[/\\]+$/, ''));
  else if (typeof fields.name === 'string') name = fields.name;
  else return refusal(manifestFile, lineOf(fields, 'name'), `the manifest ${manifestFile} holds ${shown(fields.name)} at "name": not a name, which is a word`);

  const skills = fields.skills;
  if (skills !== undefined && skills !== null) {
    if (typeof skills !== 'object' || Array.isArray(skills))
      return refusal(manifestFile, lineOf(fields, 'skills'), `the manifest ${manifestFile} holds ${shown(skills)} at "skills": the set pinned here is written as "shady2k: <version>", one line per set`);
    for (const [set, version] of Object.entries(skills as Record<string, unknown>)) {
      if (typeof version !== 'string' || version.trim() === '')
        return refusal(manifestFile, lineOf(skills, set), `the manifest ${manifestFile} holds ${shown(version)} at "skills", beside "${set}": the version of the set pinned here, as a word`);
    }
  }

  const repos: ProductRepo[] = [];
  const declared = fields.repos;
  if (declared !== undefined && declared !== null) {
    if (!Array.isArray(declared))
      return refusal(manifestFile, lineOf(fields, 'repos'), `the manifest ${manifestFile} holds ${shown(declared)} at "repos": the code repositories are a list, each item "name:", "url:" and an optional "branch:"`);
    const taken = new Set<string>();
    for (let i = 0; i < declared.length; i++) {
      const entry = declared[i] as unknown;
      const at = lineOfIndex(declared, i);
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
        return refusal(manifestFile, at, `the manifest ${manifestFile} holds ${shown(entry)} at "repos", on line ${at}: a code repository is written as "name:", "url:" and an optional "branch:"`);
      const item = entry as Record<string, unknown>;
      // A field an item leaves out is reported on the item's own line: the
      // line the reader knows is the one the item starts on.
      const atName = item.name === undefined ? at : lineOf(item, 'name');
      const atUrl = item.url === undefined ? at : lineOf(item, 'url');
      const atBranch = item.branch === undefined ? at : lineOf(item, 'branch');
      if (!isFolderName(item.name))
        return refusal(manifestFile, atName, `the manifest ${manifestFile} holds ${shown(item.name)} at "repos", beside "name": a code repository is named by the folder it is cloned into, and that name is one path segment`);
      const repoName = item.name as string;
      if (taken.has(repoName))
        return refusal(manifestFile, atName, `the manifest ${manifestFile} names the code repository "${repoName}" twice, on line ${atName}: each repository is declared once, and clones into its own folder`);
      taken.add(repoName);
      if (item.url === undefined && item.linked !== true)
        return refusal(manifestFile, atUrl, `the manifest ${manifestFile} holds nothing at \"repos\", beside \"url\": a code repository is cloned from the url it declares`);
      if (item.url !== undefined && (typeof item.url !== 'string' || item.url.trim() === ''))
        return refusal(manifestFile, atUrl, `the manifest ${manifestFile} holds ${shown(item.url)} at "repos", beside "url": a code repository url is either absent or non-empty`);
      if (item.branch !== undefined && item.branch !== null && (typeof item.branch !== 'string' || item.branch.trim() === ''))
        return refusal(manifestFile, atBranch, `the manifest ${manifestFile} holds ${shown(item.branch)} at "repos", beside "branch": the branch a clone is taken from, as a word`);
      repos.push({ name: repoName, ...(typeof item.url === 'string' ? { url: item.url } : {}), ...(item.linked === true ? { linked: true } : {}), branch: typeof item.branch === 'string' ? item.branch : undefined });
    }
  }

  return {
    ok: true,
    product: {
      folder,
      id: fields.id as string,
      name,
      schemaVersion: PRODUCT_SCHEMA_VERSION,
      skills: (skills === undefined || skills === null ? {} : skills) as ProductSkills,
      repos,
    },
  };
}

// ---- the manifest's written side: the changes madarch's commands make ------

/**
 * A word as YAML reads it back: plain where the plain spelling reads back as
 * that same word, quoted where it does not — `123`, `true` and `null` are
 * other YAML values, and a word with a space at its edge, a `:`, a `#` or a
 * leading indicator is not a plain scalar at all. A name written into a
 * manifest is a name the reader must give back, whatever it is called.
 */
export const yamlWord = (word: string): string => (/^[A-Za-z_][A-Za-z0-9 ._+-]*$/.test(word) && !/^(true|false|null)$/i.test(word)
  ? word
  : `'${word.replace(/'/g, "''")}'`);

/**
 * A url or a branch as the manifest writes it: plain where the reader gives
 * that same text back, quoted where it does not. The reader decides, and no
 * second rule is written beside it: a url a person reads stays unquoted — it
 * holds ":" and "/", which a plain scalar takes — and one the reader would
 * give back as a number, a truth, nothing, a mapping or a comment is quoted,
 * so what is written is what is read. A relative path a repository sits at
 * can be such a value: `.5` is the number `0.5` to a YAML reader.
 *
 * A value holding a character one line cannot carry — a newline, a tab, a
 * carriage return — is written double-quoted with the escapes the reader
 * understands, since a quoted scalar is one line and an escape is how YAML
 * writes such a character inside one. A name is not written this way: it is a
 * word by its own refusal, so `yamlWord` writes it.
 */
export function yamlText(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    const escaped = value.replace(/[\u0000-\u001f\u007f"\\]/g, (ch) => {
      const named: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\t': '\\t', '\r': '\\r' };
      return named[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    });
    return `"${escaped}"`;
  }
  const read = parseScalar(value, '', 1);
  const plain = read.ok && typeof read.value === 'string' && read.value === value && value.trim() === value;
  return plain ? value : `'${value.replace(/'/g, "''")}'`;
}

/**
 * The word a field's key spells, however it spells it: bare, single- or
 * double-quoted, with the escapes a double-quoted scalar takes. A key written
 * `"n\u0061me"` names `name`, and the field it names is that one — a rename
 * that matched the text of a key would leave the product's own field alone and
 * write a second one beside it.
 */
export function decodedKeyWord(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed === '') return null;
  if (trimmed[0] === "'" || trimmed[0] === '"') {
    const read = unquote(trimmed, '', 1);
    return read.ok && typeof read.value === 'string' ? read.value : null;
  }
  return cutComment(trimmed).trim();
}

/** The lines of one `repos` item, at the indentation the block's items use: the first field on the item's own line, the others indented under it. The caller ends each line the way the file ends its own. */
export function repoItemLines(repo: { name: string; url?: string; linked?: boolean; branch?: string }, indent: number): string[] {
  const field = (name: string, value: string): string => `${' '.repeat(indent + 2)}${name}: ${value}`;
  const lines = [`${' '.repeat(indent)}- name: ${yamlWord(repo.name)}`];
  if (repo.url !== undefined) lines.push(field('url', yamlText(repo.url)));
  if (repo.linked === true) lines.push(field('linked', 'true'));
  if (repo.branch !== undefined) lines.push(field('branch', yamlText(repo.branch)));
  return lines;
}

/**
 * The manifest's text with its `name` field written as the product's new
 * name, every other byte kept. The field is found by its own name, however
 * the manifest spells the key — bare, single- or double-quoted — and only
 * the value is replaced: a comment standing on that line stays where the
 * person wrote it.
 */
export function manifestNamed(text: string, name: string): string {
  const lines = text.split('\n');
  let written = false;
  const out = lines.map((line) => {
    if (written) return line;
    const cr = line.endsWith('\r') ? '\r' : '';
    const bare = cr === '' ? line : line.slice(0, -1);
    const lead = bare.match(/^[ \t]*/)![0];
    // Only the product's own field, which stands at the left margin: a
    // `name` inside `repos:` or inside any other field belongs to that field,
    // and renaming the product must never reach it.
    if (lead !== '') return line;
    const pair = splitPair(bare);
    if (pair === null || decodedKeyWord(pair.key) !== 'name') return line;
    written = true;
    // Everything else on the line stays as it was written: the key's own
    // spelling, the spacing after the colon, a comment at its end, and a
    // carriage return where the manifest has one.
    const after = bare.slice(pair.key.length + 1);
    const gap = after.match(/^[ \t]*/)![0];
    const rest = after.slice(gap.length);
    // The comment starts at its own `#`: the spaces before it were written by
    // someone, and they stay where they are.
    const comment = rest.slice(cutComment(rest).replace(/\s+$/, '').length);
    return `${pair.key}:${gap}${yamlWord(name)}${comment}${cr}`;
  });
  if (!written) {
    if (out[out.length - 1] === '') out.splice(out.length - 1, 0, `name: ${yamlWord(name)}`);
    else out.push(`name: ${yamlWord(name)}`);
  }
  return out.join('\n');
}

/**
 * The manifest's text with one code repository appended to `repos`, every
 * other byte kept: the field is found by its own name, however the manifest
 * spells the key, only where it stands at the left margin, so a `repos` of
 * another field is never reached. The item is written at the end of the
 * sequence with the indentation the sequence's own items use, and every line
 * the file already holds — a comment, a blank line, the spacing someone
 * wrote, and the line ending it ends with — stays exactly as it was.
 *
 * Three readings of `repos` the reader accepts are answered for here. A line
 * that is a comment only belongs to the block it stands among, whichever
 * indentation it is written at, since the reader drops it: it never ends the
 * sequence, so an item never lands in the middle of another one. A field
 * whose value is written (`repos: null`, `repos: ~`) holds no list, and its
 * value is taken off the line — the key's own spelling and the comment after
 * it kept — before the items are written under it. A manifest naming no
 * `repos` at all gains the block at its end.
 */
export function manifestWithRepo(text: string, repo: { name: string; url?: string; linked?: boolean; branch?: string }): string {
  // The lines are split on "\n" the way `manifestNamed` does, so a carriage
  // return a line ends with is the line's own last character: every line this
  // function inserts ends with the carriage return the file's lines do.
  const cr = text.includes('\r\n') ? '\r' : '';
  const lines = text.split('\n');
  const bare = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

  let at = -1;
  for (let i = 0; i < lines.length && at === -1; i++) {
    const body = bare(lines[i]!);
    if (body.match(/^[ \t]*/)![0] !== '') continue;
    const pair = splitPair(body);
    if (pair !== null && decodedKeyWord(pair.key) === 'repos') at = i;
  }
  if (at === -1) {
    const block = ['repos:', ...repoItemLines(repo, 2)].map((line) => `${line}${cr}`);
    // The blank element a manifest ending in a newline leaves behind is where
    // the block goes: the file keeps the ending it had.
    const end = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    lines.splice(end, 0, ...block);
    return lines.join('\n');
  }

  // The block runs to the last line indented under the field; a blank line
  // and a comment-only line belong to it — the reader drops both — and a
  // field written back at the left margin ends it.
  let indent: number | null = null;
  let last = at;
  for (let i = at + 1; i < lines.length; i++) {
    const body = bare(lines[i]!);
    const lead = body.match(/^[ \t]*/)![0].length;
    const content = body.slice(lead);
    if (body.trim() === '' || content.startsWith('#')) continue;
    if (lead === 0) break;
    last = i;
    if (indent === null && /^-(\s|$)/.test(content)) indent = lead;
  }

  // A value written on the field's own line is no list: it is taken off the
  // line, the key's spelling, the spacing after it and the comment kept, and
  // the items are written under it.
  const pair = splitPair(bare(lines[at]!))!;
  const after = bare(lines[at]!).slice(pair.key.length + 1);
  const gap = after.match(/^[ \t]*/)![0];
  const rest = after.slice(gap.length);
  const written = cutComment(rest).trim();
  if (written !== '') {
    // The comment stays, one space after the colon: the value that stood
    // between them is the field this command is writing.
    const comment = rest.slice(cutComment(rest).replace(/\s+$/, '').length).trim();
    const ending = lines[at]!.endsWith('\r') ? '\r' : '';
    lines[at] = `${pair.key}:${comment === '' ? '' : ` ${comment}`}${ending}`;
  }

  const item = repoItemLines(repo, indent === null ? 2 : indent).map((line) => `${line}${cr}`);
  lines.splice(last + 1, 0, ...item);
  return lines.join('\n');
}
