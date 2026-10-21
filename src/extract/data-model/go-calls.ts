/**
 * The one call roll-up the data-model extractor makes (madarch-o0eq.2): within
 * one Go package - a directory - a call is resolved when it is
 *
 * - a call of a function of the same package, by its name (`insertOrder`);
 * - a call of a method through a field whose type is a struct or interface of
 *   the same package (`r.outbox.Write` through the `outbox *OutboxWriter`
 *   field of the receiver);
 * - a call of a method of the receiver's own type (`r.markPublished`).
 *
 * Anything else - a call through another package's type, through a parameter,
 * through a field of a foreign type - is left unresolved rather than guessed.
 * Through the three shapes above a repository method that writes only through
 * a helper (`Create` through `insertOrder`) or through the outbox writer
 * (`Create` through `r.outbox.Write`) carries the helper's table access at
 * the call site, which is where a reader looks for it.
 */
import type {SourceSpan} from '../records.js';
import type {AccessSite, FunctionRegion} from './access.js';

/** One resolved call inside a caller: the callee's region and the call site. */
export interface ResolvedCall {
  readonly callee: FunctionRegion;
  readonly site: SourceSpan;
}

/** Everything one package's files offer a resolution: its methods, functions and struct fields. */
export interface GoPackageIndex {
  /** `Type.Method` -> the method's region, for every file of the package. */
  readonly methods: ReadonlyMap<string, FunctionRegion>;
  /** A function's bare name -> its region. */
  readonly functions: ReadonlyMap<string, FunctionRegion>;
  /** A struct's name -> its fields' names -> the type each is declared with. */
  readonly structFields: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export interface GoPackageFile {
  readonly path: string;
  readonly text: string;
  readonly regions: readonly FunctionRegion[];
}

/** Indexes one package's files: the calls a region of any of them may resolve through. */
export function indexGoPackage(files: readonly GoPackageFile[]): GoPackageIndex {
  const methods = new Map<string, FunctionRegion>();
  const functions = new Map<string, FunctionRegion>();
  const structFields = new Map<string, Map<string, string>>();
  for (const file of files) {
    for (const region of file.regions) {
      if (region.language !== 'go') continue;
      const dot = region.qualifiedName.indexOf('.');
      if (dot !== -1) methods.set(region.qualifiedName, region);
      else if (!functions.has(region.qualifiedName)) functions.set(region.qualifiedName, region);
    }
    for (const [typeName, fields] of structTypesOf(file.text)) {
      const held = structFields.get(typeName) ?? new Map<string, string>();
      for (const [field, type] of fields) if (!held.has(field)) held.set(field, type);
      structFields.set(typeName, held);
    }
  }
  return {methods, functions, structFields};
}

/** `type X struct { field *Other }` declarations of one file, their comments already spaces. */
function structTypesOf(text: string): readonly (readonly [string, ReadonlyMap<string, string>])[] {
  const out: (readonly [string, ReadonlyMap<string, string>])[] = [];
  for (const block of text.matchAll(/type\s+(\w+)\s+struct\s*\{([^}]*)\}/g)) {
    const fields = new Map<string, string>();
    for (const line of block[2]!.split('\n')) {
      const field = /^\s*(\w+)\s+(\*?[\w.]+)/.exec(line);
      if (field !== null) fields.set(field[1]!, field[2]!);
    }
    out.push([block[1]!, fields] as const);
  }
  return out;
}

/**
 * The calls one Go file's regions resolve through the package index. Comments
 * are read as spaces before the chains are found, so a commented-out call
 * resolves nothing.
 */
export function resolveGoCalls(file: GoPackageFile, index: GoPackageIndex): readonly ResolvedCall[] {
  const resolved: ResolvedCall[] = [];
  for (const region of file.regions) {
    if (region.language !== 'go') continue;
    const regionText = sliceOf(file.text, region.span);
    const masked = maskStringsAndComments(regionText);
    const receiver = receiverOf(masked);
    for (const chain of callChains(masked)) {
      const parts = chain.parts;
      let callee: FunctionRegion | undefined;
      if (receiver !== undefined && receiver.variable !== undefined && parts[0] === receiver.variable) {
        if (parts.length === 2 && receiver.type !== undefined) {
          callee = index.methods.get(`${receiver.type}.${parts[1]!}`);
        } else if (parts.length === 3 && receiver.type !== undefined) {
          const fieldType = baseTypeName(index.structFields.get(receiver.type)?.get(parts[1]!));
          if (fieldType !== undefined) callee = index.methods.get(`${fieldType}.${parts[2]!}`);
        }
      } else if (parts.length === 1) {
        callee = index.functions.get(parts[0]!);
      }
      if (callee === undefined || callee.qualifiedName === region.qualifiedName) continue;
      // The call site is the whole call expression, its arguments included
      // (`r.outbox.Write(ctx, tx, changeOf(order))`), so a record of the call
      // cites what was passed, not only the callee's name.
      const close = matchingParen(masked, chain.openParen);
      const end = close === -1 ? chain.end : close + 1;
      resolved.push({callee, site: offsetSpan(file.path, regionText, chain.start, end, region.span)});
    }
  }
  return resolved;
}

interface Receiver {
  readonly variable?: string;
  readonly type?: string;
}

function receiverOf(declarationText: string): Receiver | undefined {
  const match = /^\s*func\s*\(\s*(\w+)\s+\*?(\w+)\s*\)\s+\w+\s*\(/.exec(declarationText);
  if (match !== null) return {variable: match[1]!, type: match[2]!};
  const plain = /^\s*func\s+\w+\s*\(/.exec(declarationText);
  if (plain !== null) return {};
  return undefined;
}

/** The qualified or bare call chains of one masked region, with their places in the region's text. */
function callChains(masked: string): readonly {readonly parts: readonly string[]; readonly start: number; readonly end: number; readonly openParen: number}[] {
  const found: {parts: string[]; start: number; end: number; openParen: number}[] = [];
  for (const match of masked.matchAll(/([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)+)\s*\(/g)) {
    const openParen = (match.index ?? 0) + match[0].length - 1;
    found.push({parts: match[1]!.split('.').map((part) => part.trim()), start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, openParen});
  }
  for (const match of masked.matchAll(/(?<![.\w])([A-Za-z_]\w*)\s*\(/g)) {
    const openParen = (match.index ?? 0) + match[0].length - 1;
    found.push({parts: [match[1]!], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, openParen});
  }
  return found.sort((left, right) => left.start - right.start);
}

/** Replaces every string literal and comment with spaces, offsets kept. */
function maskStringsAndComments(text: string): string {
  const out = [...text];
  let index = 0;
  while (index < text.length) {
    if (text[index] === '/' && text[index + 1] === '/') {
      const start = index;
      while (index < text.length && text[index] !== '\n') index++;
      for (let at = start; at < index; at++) out[at] = ' ';
      continue;
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      const start = index;
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index = Math.min(text.length, index + 2);
      for (let at = start; at < index; at++) if (out[at] !== '\n') out[at] = ' ';
      continue;
    }
    if (text[index] === '"' || text[index] === '`' || text[index] === "'") {
      const quote = text[index]!;
      const start = index;
      index++;
      while (index < text.length) {
        if (quote === '"' && text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === quote) break;
        if (text[index] === '\n' && quote !== '`') break;
        index++;
      }
      index = Math.min(text.length, index + 1);
      for (let at = start; at < index; at++) if (out[at] !== '\n') out[at] = ' ';
      continue;
    }
    index++;
  }
  return out.join('');
}

function matchingParen(masked: string, open: number): number {
  let depth = 0;
  for (let index = open; index < masked.length; index++) {
    if (masked[index] === '(') depth++;
    if (masked[index] === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** A base type name: the last segment of a qualified or pointed type (`*sql.DB` is `DB`). */
function baseTypeName(typeText: string | undefined): string | undefined {
  if (typeText === undefined) return undefined;
  const withoutPointer = typeText.replace(/^\*/, '');
  const parts = withoutPointer.split('.');
  return parts[parts.length - 1];
}


function charStartOf(text: string, byte: number): number {
  let byteAt = 0;
  for (let index = 0; index < text.length; index++) {
    if (byteAt === byte) return index;
    const codePoint = text.codePointAt(index)!;
    byteAt += codePoint > 0xffff ? 4 : codePoint > 0x7f ? (codePoint > 0x7ff ? 3 : 2) : 1;
    if (codePoint > 0xffff) index++;
  }
  return text.length;
}

function sliceOf(text: string, span: SourceSpan): string {
  return text.slice(charStartOf(text, span.byteStart), charStartOf(text, span.byteEnd));
}

/** The place of a region-local range in the file: byte offsets and lines. */
function offsetSpan(path: string, regionText: string, start: number, end: number, regionSpan: SourceSpan): SourceSpan {
  const prefix = regionText.slice(0, start);
  let bytes = 0;
  let lines = 0;
  for (let index = 0; index < prefix.length; index++) {
    const codePoint = prefix.codePointAt(index)!;
    bytes += codePoint > 0xffff ? 4 : codePoint > 0x7f ? (codePoint > 0x7ff ? 3 : 2) : 1;
    if (codePoint > 0xffff) index++;
    if (prefix[index] === '\n') lines++;
  }
  const slice = regionText.slice(start, end);
  let sliceBytes = 0;
  let sliceLines = 0;
  for (let index = 0; index < slice.length; index++) {
    const codePoint = slice.codePointAt(index)!;
    sliceBytes += codePoint > 0xffff ? 4 : codePoint > 0x7f ? (codePoint > 0x7ff ? 3 : 2) : 1;
    if (codePoint > 0xffff) index++;
    if (slice[index] === '\n') sliceLines++;
  }
  return {
    path,
    byteStart: regionSpan.byteStart + bytes,
    byteEnd: regionSpan.byteStart + bytes + sliceBytes,
    lineStart: regionSpan.lineStart + lines,
    lineEnd: regionSpan.lineStart + lines + sliceLines,
  };
}
