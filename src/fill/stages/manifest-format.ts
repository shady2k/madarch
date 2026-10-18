/**
 * Reading the manifests of the build and configuration stage (decision 0026,
 * stage 2): the text formats a package, a dependency, a deploy unit, an
 * environment variable and a declared entry point are written in.
 *
 * Every reader here is strict and answers where it stopped: a text it cannot
 * read is a gap naming the 1-based line and what stood there, never a value
 * read in part and never a silence. A reader also reports the *notes* it took
 * while it read (a key declared twice), which the stage turns into the unit's
 * coverage, so nothing the reader passed over is lost.
 *
 * The readers are deliberately small subsets: `readToml` reads the tables and
 * values a Cargo manifest is written in, `readGoMod` the directives a Go
 * module is declared by, `readDockerfile` the instructions a Dockerfile is
 * built from and `readCompose` the services a compose file declares. Anything
 * outside a subset is a gap at its own line, so a manifest a later Cargo, Go
 * or Docker feature changes is reported rather than read wrongly.
 */
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { byCodePoint } from '../../model/order.js';

/** Where a reader stopped, or what it passed over: a 1-based line and a detail a reader can act on. */
export interface TextGap {
  readonly line: number;
  readonly detail: string;
}

/** What reading one manifest's text gave: what it holds with the notes taken, or where it stopped. */
export type TextRead<T> =
  | { readonly ok: true; readonly value: T; readonly gaps: readonly TextGap[] }
  | { readonly ok: false; readonly gap: TextGap };

/** A path into a parsed document: an object's key, an array's index or a table's name. */
export type TextPath = readonly (string | number)[];

/** One path's own key in the readers' line tables, so two paths never collide. */
function pathKey(path: TextPath): string {
  return JSON.stringify(path);
}

// ---- JSON and JSONC -------------------------------------------------------

/** What one JSON document holds, and where each member of it stands. */
export interface JsonReading {
  readonly value: unknown;
  /** The 1-based line of the member or element at a path; 1 where the path names nothing. */
  lineAt(path: TextPath): number;
}

/** Where the reader stopped: a line and a detail. */
class TextStop extends Error {
  constructor(readonly line: number, readonly detail: string) {
    super(detail);
    this.name = 'TextStop';
  }
}

/**
 * Reads one JSON document, as the ecosystem's own reader reads it: a comment
 * and a comma before a closing brace are gaps naming their lines, never
 * declarations read past. The reader is strict because every manifest this
 * stage reads as JSON is one whose ecosystem refuses anything else — a
 * `package.json` with a trailing comma does not install.
 */
export function readJson(text: string): TextRead<JsonReading> {
  const reader = new JsonReader(text);
  try {
    const value = reader.parseDocument();
    return { ok: true, value: { value, lineAt: (path) => reader.lineAt(path) }, gaps: reader.gaps };
  } catch (error) {
    if (error instanceof TextStop) return { ok: false, gap: { line: error.line, detail: error.detail } };
    throw error;
  }
}

/** The reader of one JSON (or JSONC) text: a cursor, the line it stands on and the lines it recorded. */
class JsonReader {
  private at = 0;
  private line = 1;
  private readonly lines = new Map<string, number>();
  readonly gaps: TextGap[] = [];

  constructor(private readonly text: string) {}

  /** The 1-based line of the member or element at a path, as the reader recorded it. */
  lineAt(path: TextPath): number {
    return this.lines.get(pathKey(path)) ?? 1;
  }

  parseDocument(): unknown {
    this.skipSpace();
    if (this.at >= this.text.length) throw new TextStop(1, 'the document is empty: a JSON document holds one value');
    const value = this.readValue([]);
    this.skipSpace();
    if (this.at < this.text.length) {
      throw new TextStop(this.line, `the document holds ${this.here()} after its value: a JSON document holds one value`);
    }
    return value;
  }

  /** What stands at the cursor, short enough to name in a refusal. */
  private here(): string {
    return JSON.stringify(this.text.slice(this.at, this.at + 12));
  }

  private skipSpace(): void {
    for (;;) {
      const char = this.text[this.at];
      if (char === undefined) return;
      if (char === '\n') {
        this.line += 1;
        this.at += 1;
        continue;
      }
      if (char === ' ' || char === '\t' || char === '\r') {
        this.at += 1;
        continue;
      }
      return;
    }
  }

  private readValue(path: TextPath): unknown {
    this.skipSpace();
    // A member's line is its key's line (recorded by the object reader): a
    // value that starts on the next line does not move the declaration.
    if (!this.lines.has(pathKey(path))) this.lines.set(pathKey(path), this.line);
    const char = this.text[this.at];
    if (char === undefined) throw new TextStop(this.line, 'the document ends where a value stands');
    if (char === '{') return this.readObject(path);
    if (char === '[') return this.readArray(path);
    if (char === '"') return this.readString();
    if (this.text.startsWith('true', this.at)) {
      this.at += 4;
      return true;
    }
    if (this.text.startsWith('false', this.at)) {
      this.at += 5;
      return false;
    }
    if (this.text.startsWith('null', this.at)) {
      this.at += 4;
      return null;
    }
    if (char === '-' || (char >= '0' && char <= '9')) return this.readNumber();
    throw new TextStop(this.line, `${this.here()} is no value: a value is an object, an array, a string, a number, true, false or null`);
  }

  private readObject(path: TextPath): Record<string, unknown> {
    this.at += 1;
    const value: Record<string, unknown> = {};
    for (;;) {
      this.skipSpace();
      const char = this.text[this.at];
      if (char === '}') {
        this.at += 1;
        return value;
      }
      if (char === undefined) throw new TextStop(this.line, 'the object is never closed: a "}" is missing');
      const keyLine = this.line;
      if (char !== '"') throw new TextStop(this.line, `${this.here()} is no member: a member is a quoted key, a ":". and a value`);
      const key = this.readString();
      this.skipSpace();
      if (this.text[this.at] !== ':') throw new TextStop(this.line, `the member ${JSON.stringify(key)} is followed by ${this.here()}: a member's key is followed by ":"`);
      this.at += 1;
      const inner: TextPath = [...path, key];
      this.lines.set(pathKey(inner), keyLine);
      const member = this.readValue(inner);
      if (Object.hasOwn(value, key)) {
        this.gaps.push({ line: keyLine, detail: `the member ${JSON.stringify(key)} is declared twice: the first declaration stands, and the second is not read` });
      } else {
        value[key] = member;
      }
      this.skipSpace();
      const after = this.text[this.at];
      if (after === ',') {
        this.at += 1;
        continue;
      }
      if (after === '}') {
        this.at += 1;
        return value;
      }
      throw new TextStop(this.line, `the member ${JSON.stringify(key)} is followed by ${this.here()}: a member ends with "," or "}"`);
    }
  }

  private readArray(path: TextPath): unknown[] {
    this.at += 1;
    const value: unknown[] = [];
    for (;;) {
      this.skipSpace();
      const char = this.text[this.at];
      if (char === ']') {
        this.at += 1;
        return value;
      }
      if (char === undefined) throw new TextStop(this.line, 'the array is never closed: a "]" is missing');
      value.push(this.readValue([...path, value.length]));
      this.skipSpace();
      const after = this.text[this.at];
      if (after === ',') {
        this.at += 1;
        continue;
      }
      if (after === ']') {
        this.at += 1;
        return value;
      }
      throw new TextStop(this.line, `an element of the array is followed by ${this.here()}: an element ends with "," or "]"`);
    }
  }

  private readString(): string {
    const opened = this.line;
    this.at += 1;
    let out = '';
    for (;;) {
      const char = this.text[this.at];
      if (char === undefined) throw new TextStop(opened, 'the string is never closed: a `"` is missing');
      if (char === '\n') throw new TextStop(opened, 'the string is never closed: a `"` is missing before the end of its line');
      if (char === '"') {
        this.at += 1;
        return out;
      }
      if (char === '\\') {
        const escape = this.text[this.at + 1];
        const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (escape !== undefined && Object.hasOwn(simple, escape)) {
          out += simple[escape] ?? '';
          this.at += 2;
          continue;
        }
        if (escape === 'u') {
          const digits = this.text.slice(this.at + 2, this.at + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw new TextStop(this.line, `the escape ${JSON.stringify(this.text.slice(this.at, this.at + 6))} is no escape: \\u is followed by four hexadecimal digits`);
          out += String.fromCharCode(Number.parseInt(digits, 16));
          this.at += 6;
          continue;
        }
        throw new TextStop(this.line, `the escape ${JSON.stringify(this.text.slice(this.at, this.at + 2))} is no escape: a string escapes ", \\, /, b, f, n, r, t or u`);
      }
      if (char.charCodeAt(0) < 0x20) throw new TextStop(this.line, 'a control character stands inside the string: a string spells one as its escape');
      out += char;
      this.at += 1;
    }
  }

  private readNumber(): number {
    const rest = this.text.slice(this.at);
    const digits = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (digits === null) throw new TextStop(this.line, `${this.here()} is no number`);
    this.at += digits[0].length;
    return Number(digits[0]);
  }
}

// ---- TOML -----------------------------------------------------------------

/** What one TOML document holds, and where each key of it stands. */
export interface TomlReading {
  readonly value: Readonly<Record<string, unknown>>;
  /** The 1-based line of the key at a path; 1 where the path names nothing. */
  lineAt(path: TextPath): number;
}

/**
 * Reads the TOML a Cargo manifest is written in: tables and arrays of tables,
 * keys, and the string, number, boolean, array and inline-table values a
 * manifest uses. A multiline string, a date and anything else outside that
 * subset is a gap at its own line rather than a value read wrongly.
 */
export function readToml(text: string): TextRead<TomlReading> {
  const root: Record<string, unknown> = {};
  const lines = new Map<string, number>();
  const gaps: TextGap[] = [];
  let table: Record<string, unknown> = root;
  let at: TextPath = [];
  const physical = text.split('\n');
  try {
    physical.forEach((raw, index) => {
      const line = index + 1;
      const body = stripComment(raw).trim();
      if (body === '') return;
      if (body.startsWith('[[')) {
        if (!body.endsWith(']]')) throw new TextStop(line, `${JSON.stringify(body)} is no table header: an array of tables is written [[name]]`);
        const keys = readTomlKey(body.slice(2, -2).trim(), line);
        const held = descend(root, keys.slice(0, -1), line, true);
        const name = keys[keys.length - 1] ?? '';
        const list = Object.hasOwn(held, name) ? held[name] : [];
        if (!Array.isArray(list)) throw new TextStop(line, `the key ${JSON.stringify(name)} stands as a table and as an array of tables: one key holds one shape`);
        const fresh: Record<string, unknown> = {};
        list.push(fresh);
        held[name] = list;
        at = [...keys.slice(0, -1), name, list.length - 1];
        lines.set(pathKey(at), line);
        table = fresh;
        return;
      }
      if (body.startsWith('[')) {
        if (!body.endsWith(']')) throw new TextStop(line, `${JSON.stringify(body)} is no table header: a table is written [name]`);
        const keys = readTomlKey(body.slice(1, -1).trim(), line);
        table = descend(root, keys, line, true);
        at = keys;
        if (lines.has(pathKey(at))) {
          // A table declared twice adds its keys to the first, as TOML's own
          // rule reads it; the repetition is noted, since which of two headers
          // a reader meant is not this reader's to guess.
          gaps.push({ line, detail: `the table ${JSON.stringify(keys.join('.'))} is declared twice: its keys stand in the first declaration` });
        }
        lines.set(pathKey(at), line);
        return;
      }
      const equals = indexOfEquals(body);
      if (equals < 0) throw new TextStop(line, `${JSON.stringify(body)} is no declaration: a line declares a table ([name]) or a key's value (key = value)`);
      const keys = readTomlKey(body.slice(0, equals).trim(), line);
      const parsed = readTomlValue(body.slice(equals + 1).trim(), line);
      const holder = descend(table, keys.slice(0, -1), line, true);
      const name = keys[keys.length - 1] ?? '';
      const where: TextPath = [...at, ...keys];
      if (Object.hasOwn(holder, name)) {
        gaps.push({ line, detail: `the key ${JSON.stringify(where.join('.'))} is declared twice: the first declaration stands, and the second is not read` });
        return;
      }
      holder[name] = parsed;
      lines.set(pathKey(where), line);
    });
  } catch (error) {
    if (error instanceof TextStop) return { ok: false, gap: { line: error.line, detail: error.detail } };
    throw error;
  }
  return { ok: true, value: { value: root, lineAt: (path) => lines.get(pathKey(path)) ?? 1 }, gaps };
}

/** The table at a dotted path, made where it does not stand yet. */
function descend(root: Record<string, unknown>, keys: TextPath, line: number, make: boolean): Record<string, unknown> {
  let held = root;
  for (const key of keys) {
    const name = String(key);
    const next = held[name];
    if (next === undefined) {
      if (!make) {
        // A dotted key writing into a table the file never declared: what that
        // means is TOML's own rule, and this reader does not guess it.
        throw new TextStop(line, `the table ${JSON.stringify(name)} is not declared: a dotted key stands in a table the file declares`);
      }
      const fresh: Record<string, unknown> = {};
      held[name] = fresh;
      held = fresh;
      continue;
    }
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      throw new TextStop(line, `the key ${JSON.stringify(name)} holds a value and no table: a table's name stands in no other key`);
    }
    held = next as Record<string, unknown>;
  }
  return held;
}

/** The line without its comment: a `#` outside a string ends it. */
function stripComment(text: string): string {
  let quote = '';
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quote !== '') {
      if (char === '\\' && quote === '"') at += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') return text.slice(0, at);
  }
  return text;
}

/** Where the `=` of a declaration stands, outside the key's quotes. */
function indexOfEquals(text: string): number {
  let quote = '';
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quote !== '') {
      if (char === '\\' && quote === '"') at += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '=') return at;
  }
  return -1;
}

/** The keys of a declaration or a table header: bare names and quoted names, dotted. */
function readTomlKey(text: string, line: number): string[] {
  if (text === '') throw new TextStop(line, 'the declaration names no key');
  const keys: string[] = [];
  let at = 0;
  for (;;) {
    while (text[at] === ' ' || text[at] === '\t') at += 1;
    const char = text[at];
    if (char === '"' || char === "'") {
      const read = readTomlString(text, at, line);
      keys.push(read.value);
      at = read.at;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(at));
      if (bare === null) throw new TextStop(line, `${JSON.stringify(text.slice(at, at + 8))} is no key: a key is a bare name or a quoted name`);
      keys.push(bare[0]);
      at += bare[0].length;
    }
    while (text[at] === ' ' || text[at] === '\t') at += 1;
    if (at >= text.length) return keys;
    if (text[at] !== '.') throw new TextStop(line, `${JSON.stringify(text.slice(at, at + 8))} stands after the key ${JSON.stringify(keys.join('.'))}: keys are separated by "."`);
    at += 1;
  }
}

/** One TOML string, at a position inside its line. */
function readTomlString(text: string, at: number, line: number): { value: string; at: number } {
  const quote = text[at];
  if (text.startsWith(quote === '"' ? '"""' : "'''", at)) {
    throw new TextStop(line, 'a multiline string stands here: this reader reads a single-line string');
  }
  let out = '';
  let cursor = at + 1;
  for (;;) {
    const char = text[cursor];
    if (char === undefined) throw new TextStop(line, 'the string is never closed');
    if (char === quote) return { value: out, at: cursor + 1 };
    if (char === '\\' && quote === '"') {
      const escape = text[cursor + 1];
      const simple: Record<string, string> = { '"': '"', '\\': '\\', b: '\b', t: '\t', n: '\n', f: '\f', r: '\r' };
      if (escape !== undefined && Object.hasOwn(simple, escape)) {
        out += simple[escape] ?? '';
        cursor += 2;
        continue;
      }
      if (escape === 'u' || escape === 'U') {
        const width = escape === 'u' ? 4 : 8;
        const digits = text.slice(cursor + 2, cursor + 2 + width);
        if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(digits)) {
          throw new TextStop(line, `the escape ${JSON.stringify(text.slice(cursor, cursor + 2 + width))} is no escape: an escape of u is followed by ${width} hexadecimal digits`);
        }
        out += String.fromCodePoint(Number.parseInt(digits, 16));
        cursor += 2 + width;
        continue;
      }
      throw new TextStop(line, `the escape ${JSON.stringify(text.slice(cursor, cursor + 2))} is no escape: a basic string escapes a quote, a backslash, b, t, n, f, r, u or U`);
    }
    out += char;
    cursor += 1;
  }
}

/** One TOML value: a string, a number, a boolean, an array or an inline table. */
function readTomlValue(text: string, line: number): unknown {
  const value = text.trim();
  const char = value[0];
  if (char === undefined) throw new TextStop(line, 'the declaration writes no value');
  if (char === '"' || char === "'") {
    const read = readTomlString(value, 0, line);
    if (value.slice(read.at).trim() !== '') throw new TextStop(line, `${JSON.stringify(value.slice(read.at).trim())} stands after the value`);
    return read.value;
  }
  if (char === '[') {
    if (!value.endsWith(']')) throw new TextStop(line, 'an array spanning more than one line stands here: this reader reads a single-line array');
    const items: unknown[] = [];
    for (const item of splitTomlItems(value.slice(1, -1), line)) {
      if (item.trim() === '') continue;
      items.push(readTomlValue(item, line));
    }
    return items;
  }
  if (char === '{') {
    if (!value.endsWith('}')) throw new TextStop(line, 'an inline table spanning more than one line stands here: this reader reads a single-line inline table');
    const table: Record<string, unknown> = {};
    for (const item of splitTomlItems(value.slice(1, -1), line)) {
      if (item.trim() === '') continue;
      const equals = indexOfEquals(item);
      if (equals < 0) throw new TextStop(line, `${JSON.stringify(item.trim())} is no member: an inline table holds key = value`);
      const keys = readTomlKey(item.slice(0, equals).trim(), line);
      const holder = descend(table, keys.slice(0, -1), line, true);
      holder[keys[keys.length - 1] ?? ''] = readTomlValue(item.slice(equals + 1), line);
    }
    return table;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^[+-]?[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?$/.test(value)) return Number(value.replace(/_/gu, ''));
  if (/^[+-]?0[xob][0-9a-fA-F_]+$/u.test(value)) return Number(value.replace(/_/gu, ''));
  throw new TextStop(line, `${JSON.stringify(value)} is no value this reader reads: a value is a string, a number, a boolean, an array or an inline table`);
}

/** The items of an array or an inline table, split at its commas, outside strings and nested brackets. */
function splitTomlItems(text: string, line: number): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quote !== '') {
      if (char === '\\' && quote === '"') at += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      items.push(text.slice(start, at));
      start = at + 1;
    }
  }
  if (depth !== 0 || quote !== '') throw new TextStop(line, `${JSON.stringify(text)} is no array or inline table: its brackets or quotes never close`);
  items.push(text.slice(start));
  return items;
}

// ---- go.mod ---------------------------------------------------------------

/** What one go.mod holds: the module it declares and the modules it requires. */
export interface GoModReading {
  readonly module: string;
  /** The modules it requires, each with the line that declares it, in the file's own order. */
  readonly requires: readonly { readonly path: string; readonly line: number }[];
  /** The directives the file used, code point order, each once. */
  readonly read: readonly string[];
}

/** The directives a go.mod is written with, as this reader knows them. */
const GO_DIRECTIVES: readonly string[] = ['exclude', 'go', 'godebug', 'module', 'replace', 'require', 'retract', 'tool', 'toolchain'];

/**
 * Reads the directives a Go module is declared by (go.mod): the `module` line
 * and every `require`, in the single-line and the block form. Every other
 * directive is read and named, since a stage 2 fact carries no version, no
 * replacement and no exclusion; a line that is no directive at all is a gap
 * naming its line.
 */
export function readGoMod(text: string): TextRead<GoModReading> {
  const requires: { path: string; line: number }[] = [];
  const read = new Set<string>();
  let module: string | undefined;
  let block: string | undefined;
  const physical = text.split('\n');
  try {
    physical.forEach((raw, index) => {
      const line = index + 1;
      const body = raw.split('//')[0]?.trim() ?? '';
      if (body === '') return;
      if (block !== undefined) {
        if (body === ')') {
          block = undefined;
          return;
        }
        if (block === 'require') requires.push(requireOf(body, line));
        return;
      }
      const head = body.split(/\s+/u)[0] ?? '';
      // `require (` and `require(` are one directive: a block's opening bracket
      // may stand against its name.
      const attached = /^([a-z]+)\($/u.exec(head)?.[1];
      const name = attached ?? head;
      const rest = attached === undefined ? body.split(/\s+/u).slice(1) : ['('];
      if (!GO_DIRECTIVES.includes(name)) {
        throw new TextStop(line, `${JSON.stringify(body)} is no go.mod line: a line is a directive (${GO_DIRECTIVES.join(', ')}) or a declaration inside one`);
      }
      read.add(name);
      const argument = rest.join(' ').trim();
      if (argument === '(') {
        block = name;
        return;
      }
      if (argument.endsWith('(')) {
        block = name;
        return;
      }
      if (name === 'module') {
        if (module !== undefined) throw new TextStop(line, 'the file declares a second module: a go.mod names one module');
        if (argument === '') throw new TextStop(line, 'the module directive names no module path');
        module = argument;
      }
      if (name === 'require') requires.push(requireOf(argument, line));
    });
  } catch (error) {
    if (error instanceof TextStop) return { ok: false, gap: { line: error.line, detail: error.detail } };
    throw error;
  }
  if (block !== undefined) {
    return { ok: false, gap: { line: physical.length, detail: `the ${block} block is never closed: a ")" is missing` } };
  }
  if (module === undefined) {
    return { ok: false, gap: { line: 1, detail: 'the file declares no module: a go.mod names the module it is' } };
  }
  return { ok: true, value: { module, requires, read: [...read].sort(byCodePoint) }, gaps: [] };
}

/** One required module: its path and the line it stands on. */
function requireOf(text: string, line: number): { path: string; line: number } {
  const [path, version, ...rest] = text.split(/\s+/u);
  if (path === undefined || path === '' || version === undefined || version === '') {
    throw new TextStop(line, `${JSON.stringify(text)} is no requirement: a requirement is a module path and its version`);
  }
  if (rest.length > 0) {
    throw new TextStop(line, `${JSON.stringify(rest.join(' '))} stands after the requirement ${JSON.stringify(path)}: a requirement is a module path and its version`);
  }
  return { path, line };
}

// ---- Dockerfile -----------------------------------------------------------

/** One instruction of a Dockerfile, as it reads a logical line. */
export interface DockerfileInstruction {
  /** The instruction's own name, upper case as Docker spells it (`FROM`, `ENV`). */
  readonly name: string;
  /** Everything after the instruction's name, trimmed. */
  readonly argument: string;
  /** The 1-based line where the instruction starts. */
  readonly line: number;
}

/** What one Dockerfile holds. */
export interface DockerfileReading {
  readonly instructions: readonly DockerfileInstruction[];
}

/** Every instruction Docker builds a file from; a name outside this list is a gap. */
const DOCKER_INSTRUCTIONS: readonly string[] = [
  'ADD', 'ARG', 'CMD', 'COPY', 'ENTRYPOINT', 'ENV', 'EXPOSE', 'FROM', 'HEALTHCHECK', 'LABEL', 'MAINTAINER',
  'ONBUILD', 'RUN', 'SHELL', 'STOPSIGNAL', 'USER', 'VOLUME', 'WORKDIR',
];

/**
 * Reads the instructions of a Dockerfile: a physical line's trailing `\`
 * continues it, a comment line is dropped, an instruction name this reader
 * does not know stops it at its own line, and a continuation that never ends
 * stops it where it began. What it read is the instructions; what a `RUN`,
 * `COPY` or `LABEL` says is no fact of stage 2 and is not parsed further.
 */
export function readDockerfile(text: string): TextRead<DockerfileReading> {
  const instructions: DockerfileInstruction[] = [];
  const physical = text.split('\n');
  try {
    let at = 0;
    while (at < physical.length) {
      const line = at + 1;
      const raw = physical[at] ?? '';
      at += 1;
      if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
      let joined = raw;
      let opened = line;
      while (joined.trimEnd().endsWith('\\')) {
        if (at >= physical.length) {
          throw new TextStop(opened, 'the instruction is continued past the end of the file: a line ending in "\\" continues into the next line');
        }
        const next = physical[at] ?? '';
        at += 1;
        if (next.trimStart().startsWith('#')) continue;
        joined = `${joined.trimEnd().slice(0, -1)} ${next.trim()}`;
      }
      const body = joined.trim();
      const name = /^[A-Za-z]+/.exec(body)?.[0];
      if (name === undefined) {
        throw new TextStop(opened, `${JSON.stringify(body)} is no instruction: an instruction is a name and its argument`);
      }
      const upper = name.toUpperCase();
      if (!DOCKER_INSTRUCTIONS.includes(upper)) {
        throw new TextStop(opened, `${JSON.stringify(name)} is no Dockerfile instruction: a Dockerfile is built from ${DOCKER_INSTRUCTIONS.join(', ')}`);
      }
      instructions.push({ name: upper, argument: body.slice(name.length).trim(), line: opened });
    }
  } catch (error) {
    if (error instanceof TextStop) return { ok: false, gap: { line: error.line, detail: error.detail } };
    throw error;
  }
  return { ok: true, value: { instructions }, gaps: [] };
}

// ---- compose files --------------------------------------------------------

/** One environment variable one compose service declares. */
export interface ComposeVariable {
  readonly name: string;
  readonly line: number;
  /** Whether the service binds a value here; `false` where it declares the variable alone. */
  readonly bound: boolean;
}

/** One file a compose service takes its environment from: read by nobody here. */
export interface ComposeEnvFile {
  /** The file as the service names it. */
  readonly named: string;
  readonly line: number;
}

/** One service of a compose file. */
export interface ComposeService {
  readonly name: string;
  readonly line: number;
  readonly environment: readonly ComposeVariable[];
  readonly envFiles: readonly ComposeEnvFile[];
}

/** What one compose file declares. */
export interface ComposeReading {
  readonly services: readonly ComposeService[];
}

/**
 * Reads the services a compose file declares: each service's name, the
 * environment variables it declares (`environment:` as a mapping or as a list
 * of `KEY=value`), and the `env_file:` entries, which name files this stage
 * does not read and reports instead. A YAML the reader refuses, a service that
 * is no mapping and a variable that is no name are gaps naming their line.
 */
export function readCompose(text: string): TextRead<ComposeReading> {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, keepSourceTokens: true, merge: false, uniqueKeys: false });
  const first = document.errors[0];
  if (first !== undefined) {
    return { ok: false, gap: { line: lineCounter.linePos(first.pos[0]).line, detail: first.message } };
  }
  const contents = document.contents;
  if (!isMap(contents)) {
    return { ok: false, gap: { line: lineOf(contents, lineCounter), detail: 'the file is no mapping: a compose file is a mapping with a "services" key' } };
  }
  const services = entryOf(contents, 'services');
  if (services === undefined) {
    return { ok: false, gap: { line: lineOf(contents, lineCounter), detail: 'the file declares no services: a compose file is a mapping with a "services" key' } };
  }
  if (!isMap(services)) {
    return { ok: false, gap: { line: lineOf(services, lineCounter), detail: 'the "services" key holds no mapping: it maps each service name to what the service is' } };
  }
  // A key declared twice is noted and not resolved: yaml's own duplicate-key
  // error is off (`uniqueKeys: false`), since a compose file may hold two
  // `services:` blocks and this reader reads the first, naming the second.
  const gaps: TextGap[] = [...repeatedKeys(contents, lineCounter), ...repeatedKeys(services, lineCounter)];
  const read: ComposeService[] = [];
  for (const pair of services.items) {
    const key = pair.key;
    if (!isScalar(key) || typeof key.value !== 'string') {
      return { ok: false, gap: { line: lineOf(key, lineCounter), detail: 'a service name is no name: a compose service is named by a string' } };
    }
    const serviceName = key.value;
    const serviceLine = lineOf(key, lineCounter);
    const environment: ComposeVariable[] = [];
    const envFiles: ComposeEnvFile[] = [];
    const body = pair.value;
    if (body !== null && body !== undefined) {
      if (!isMap(body)) {
        return { ok: false, gap: { line: lineOf(body, lineCounter), detail: `the service ${JSON.stringify(serviceName)} is no mapping: a service is a mapping of what it declares` } };
      }
      gaps.push(...repeatedKeys(body, lineCounter));
      const declared = entryOf(body, 'environment');
      if (declared !== undefined) {
        if (isMap(declared)) {
          for (const variable of declared.items) {
            const variableKey = variable.key;
            if (!isScalar(variableKey) || typeof variableKey.value !== 'string' || variableKey.value === '') {
              return { ok: false, gap: { line: lineOf(variableKey, lineCounter), detail: `an environment variable of the service ${JSON.stringify(serviceName)} is no name: a variable is named by a string` } };
            }
            environment.push({ name: variableKey.value, line: lineOf(variableKey, lineCounter), bound: variable.value !== null && variable.value !== undefined });
          }
        } else if (isSeq(declared)) {
          for (const item of declared.items) {
            if (!isScalar(item) || typeof item.value !== 'string' || item.value.trim() === '') {
              return { ok: false, gap: { line: lineOf(item, lineCounter), detail: `an entry of the environment of the service ${JSON.stringify(serviceName)} is no variable: an entry is "KEY=value" or "KEY"` } };
            }
            const at = item.value.indexOf('=');
            const variable = at < 0 ? item.value.trim() : item.value.slice(0, at).trim();
            if (variable === '') {
              return { ok: false, gap: { line: lineOf(item, lineCounter), detail: `an entry of the environment of the service ${JSON.stringify(serviceName)} names no variable: an entry is "KEY=value" or "KEY"` } };
            }
            environment.push({ name: variable, line: lineOf(item, lineCounter), bound: at >= 0 });
          }
        } else {
          return { ok: false, gap: { line: lineOf(declared, lineCounter), detail: `the environment of the service ${JSON.stringify(serviceName)} is no mapping and no list: it maps a variable's name to its value, or lists "KEY=value"` } };
        }
      }
      const envFile = entryOf(body, 'env_file');
      if (envFile !== undefined) {
        const named = isSeq(envFile) ? envFile.items : [envFile];
        for (const item of named) {
          const path = pathOfEnvFile(item);
          if (path === undefined) {
            return { ok: false, gap: { line: lineOf(item, lineCounter), detail: `an env_file of the service ${JSON.stringify(serviceName)} names no file: an env_file is a path, or a mapping with a "path"` } };
          }
          envFiles.push({ named: path, line: lineOf(item, lineCounter) });
        }
      }
    }
    environment.sort((left, right) => byCodePoint(left.name, right.name) || left.line - right.line);
    read.push({ name: serviceName, line: serviceLine, environment, envFiles });
  }
  read.sort((left, right) => byCodePoint(left.name, right.name));
  return { ok: true, value: { services: read }, gaps };
}

/** The keys one YAML mapping declares more than once, in code point order, each with the line it repeats at. */
function repeatedKeys(map: { readonly items: readonly { readonly key: unknown; readonly value: unknown }[] }, lineCounter: LineCounter): TextGap[] {
  const seen = new Set<string>();
  const gaps: TextGap[] = [];
  for (const pair of map.items) {
    const key = pair.key;
    const name = isScalar(key) && typeof key.value === 'string' ? key.value : undefined;
    if (name === undefined) continue;
    if (!seen.has(name)) {
      seen.add(name);
      continue;
    }
    gaps.push({ line: lineOf(key, lineCounter), detail: `the key ${JSON.stringify(name)} is declared twice: the first declaration stands, and the second is not read` });
  }
  return gaps.sort((left, right) => byCodePoint(left.detail, right.detail));
}

/** The path one `env_file` entry names, in either of the two forms compose allows. */
function pathOfEnvFile(node: unknown): string | undefined {
  if (isScalar(node) && typeof node.value === 'string' && node.value.trim() !== '') return node.value;
  if (isMap(node)) {
    const path = entryOf(node, 'path');
    if (path !== undefined && isScalar(path) && typeof path.value === 'string' && path.value.trim() !== '') return path.value;
  }
  return undefined;
}

/** The value of one key of a YAML mapping, where the key is a string. */
function entryOf(map: { readonly items: readonly { readonly key: unknown; readonly value: unknown }[] }, wanted: string): unknown {
  for (const pair of map.items) {
    const key = pair.key;
    if (isScalar(key) && key.value === wanted) return pair.value;
  }
  return undefined;
}

/** The 1-based line a YAML node stands on. */
function lineOf(node: unknown, lineCounter: LineCounter): number {
  const range = (node as { readonly range?: readonly [number, number, number] } | null)?.range;
  return lineCounter.linePos(range === undefined ? 0 : range[0]).line;
}
