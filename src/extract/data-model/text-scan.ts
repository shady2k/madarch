/**
 * Byte-accurate scanning of source text: the strings and comments a file's
 * bytes hold, and the byte offset of every character, so a scanner that reads
 * the decoded text can still cite half-open byte spans (records.ts,
 * SourceSpan). Pure: the text in, the findings out.
 */

/** One string literal: its content's half-open byte span, without the quotes. */
export interface ScannedString {
  readonly byteStart: number;
  readonly byteEnd: number;
}

/** One comment: its half-open byte span, markers included. */
export interface ScannedComment {
  readonly byteStart: number;
  readonly byteEnd: number;
}

export interface ScannedText {
  readonly strings: readonly ScannedString[];
  readonly comments: readonly ScannedComment[];
}

/** A line index over one file's bytes: 1-based lines of byte offsets, and byte offsets of characters. */
export class ByteText {
  readonly byteOffsets: readonly number[];
  readonly lineStarts: readonly number[];
  readonly byteLength: number;

  constructor(readonly text: string) {
    const byteOffsets = new Array<number>(text.length + 1);
    let byte = 0;
    for (let index = 0; index < text.length; index++) {
      byteOffsets[index] = byte;
      const codePoint = text.codePointAt(index)!;
      byte += codePoint > 0xffff ? 4 : codePoint > 0x7f ? (codePoint > 0x7ff ? 3 : 2) : 1;
      if (codePoint > 0xffff) index++;
      byteOffsets[index + 1] = byte;
    }
    byteOffsets[text.length] = byte;
    this.byteOffsets = byteOffsets;
    this.byteLength = byte;
    const lineStarts: number[] = [0];
    for (let index = 0; index < text.length; index++) {
      if (text[index] === '\n') lineStarts.push(byteOffsets[index + 1]!);
    }
    this.lineStarts = lineStarts;
  }

  byteAt(charIndex: number): number {
    return this.byteOffsets[charIndex] ?? this.byteLength;
  }

  /** The 1-based line a byte offset stands on. */
  lineOf(byteOffset: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.lineStarts[middle]! <= byteOffset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }
}

/**
 * The strings and comments of Go source: double-quoted strings with `\`
 * escapes, raw strings in backticks without escapes, rune literals in single
 * quotes skipped, `//` line comments and `/*` block comments.
 */
export function scanGoText(text: string): ScannedText {
  return scanCLikeText(text, { rawQuotes: ['`'] });
}

/**
 * The strings and comments of TypeScript, JavaScript and TSX source: strings
 * in `'`, `"` or backticks with `\` escapes, `//` line comments and `/*`
 * block comments.
 */
export function scanTsLikeText(text: string): ScannedText {
  return scanCLikeText(text, {});
}

function scanCLikeText(text: string, options: {rawQuotes?: readonly string[]}): ScannedText {
  const rawQuotes = options.rawQuotes ?? [];
  const strings: ScannedString[] = [];
  const comments: ScannedComment[] = [];
  const offsets = new ByteText(text).byteOffsets;
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    const next = text[index + 1];
    if (character === '/' && next === '/') {
      const start = index;
      while (index < text.length && text[index] !== '\n') index++;
      comments.push({byteStart: offsets[start]!, byteEnd: offsets[index]!});
      continue;
    }
    if (character === '/' && next === '*') {
      const start = index;
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index = Math.min(text.length, index + 2);
      comments.push({byteStart: offsets[start]!, byteEnd: offsets[index]!});
      continue;
    }
    if (character === '"' || character === "'" || rawQuotes.includes(character)) {
      const quote = character;
      index++;
      const contentStart = index;
      let closed = false;
      while (index < text.length) {
        if (quote !== '`' && text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          closed = true;
          break;
        }
        if (text[index] === '\n' && quote !== '`') break;
        index++;
      }
      if (closed) {
        // The content is strictly between the quotes.
        strings.push({byteStart: offsets[contentStart]!, byteEnd: offsets[index]!});
        index++;
      }
      continue;
    }
    index++;
  }
  return {strings, comments};
}

/** Whether a half-open byte span stands inside one of the given spans. */
export function insideAny(byteStart: number, byteEnd: number, spans: readonly {byteStart: number; byteEnd: number}[]): boolean {
  return spans.some((span) => byteStart >= span.byteStart && byteEnd <= span.byteEnd);
}
