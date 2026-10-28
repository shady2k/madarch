/** Decode tokens already classified by the grammar; never discover syntax in source text. */
export function decodeStringToken(kind: string, raw: string): string | undefined {
  if (raw.length < 2) return undefined;
  if (kind === 'raw_string_literal') return raw.slice(1, -1).split('\r').join('');
  if (kind !== 'string' && kind !== 'template_string' && kind !== 'interpreted_string_literal') return undefined;
  const quote = raw[0];
  if (raw[raw.length - 1] !== quote) return undefined;
  if (kind === 'template_string' && raw.includes('${')) return undefined;
  const go = kind === 'interpreted_string_literal';
  let result = '';
  for (let at = 1; at < raw.length - 1; at++) {
    const char = raw[at]!;
    if (char !== '\\') { result += char; continue; }
    const escape = raw[++at];
    if (escape === undefined) return undefined;
    const simple: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'" };
    if (simple[escape] !== undefined) { result += simple[escape]; continue; }
    if (go && escape === 'a') { result += '\x07'; continue; }
    if (!go && (escape === '\n' || escape === '\r')) { if (escape === '\r' && raw[at + 1] === '\n') at++; continue; }
    if (escape === 'x' || escape === 'u' || go && escape === 'U') {
      let count = escape === 'x' ? 2 : escape === 'U' ? 8 : 4;
      let end: number;
      if (!go && escape === 'u' && raw[at + 1] === '{') {
        const close = raw.indexOf('}', at + 2);
        if (close < 0) return undefined;
        at++; count = close - at - 1; end = close;
      } else end = at + count;
      if (count < 1 || count > 8 || end >= raw.length - 1) return undefined;
      let code = 0;
      for (let i = at + 1; i <= end; i++) {
        if (raw[i] === '}') break;
        const digit = '0123456789abcdef'.indexOf(raw[i]!.toLowerCase());
        if (digit < 0) return undefined;
        code = code * 16 + digit;
      }
      if (code > 0x10ffff || go && code >= 0xd800 && code <= 0xdfff || go && escape === 'x' && code > 127) return undefined;
      result += String.fromCodePoint(code); at = end; continue;
    }
    if (go && '01234567'.includes(escape)) {
      const digits = raw.slice(at, at + 3);
      if (digits.length !== 3 || [...digits].some((digit) => !'01234567'.includes(digit))) return undefined;
      const code = Number.parseInt(digits, 8);
      if (code > 127) return undefined; // Non-ASCII byte escapes need a byte decoder, not Unicode coercion.
      result += String.fromCharCode(code); at += 2; continue;
    }
    if (!go && escape === '0' && !'0123456789'.includes(raw[at + 1] ?? '')) { result += '\0'; continue; }
    // Legacy octal, template substitutions and unknown Go escapes are unsupported.
    if (go || '0123456789'.includes(escape)) return undefined;
    result += escape;
  }
  return result;
}

/** Numeric grammar tokens with language-specific base rules; unsafe values stay unknown. */
export function decodeNumberToken(kind: string, raw: string, go: boolean): number | undefined {
  const token = raw.split('_').join('');
  if (token === '') return undefined;
  if (go && kind === 'int_literal' && token.length > 1 && token[0] === '0' && '01234567'.includes(token[1]!)) {
    if ([...token].some((digit) => !'01234567'.includes(digit))) return undefined;
    const value = Number.parseInt(token, 8);
    return Number.isSafeInteger(value) ? value : undefined;
  }
  const value = Number(token);
  if (!Number.isFinite(value)) return undefined;
  if ((go && kind === 'int_literal' || !go && !token.includes('.') && !token.toLowerCase().includes('e')) && !Number.isSafeInteger(value)) return undefined;
  return value;
}
