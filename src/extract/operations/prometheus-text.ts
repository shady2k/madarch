/** Bounded Prometheus text 0.0.4 grammar over decoded literal values, never source bytes. */
export interface PrometheusTextRange { readonly start: number; readonly end: number; readonly line: number }
export interface PrometheusTextDeclaration extends PrometheusTextRange {
  readonly name: string;
  readonly kind: 'help' | 'type';
  readonly value: string;
}
export interface PrometheusTextSample extends PrometheusTextRange {
  readonly name: string;
  readonly labels: readonly string[];
  /** Zero-based printf argument, excluding the writer and format arguments. */
  readonly valueArgument?: number;
  readonly labelArguments: readonly number[];
}
export interface PrometheusTextError { readonly line: number; readonly column: number; readonly reason: string }
export interface PrometheusTextResult {
  readonly declarations: readonly PrometheusTextDeclaration[];
  readonly samples: readonly PrometheusTextSample[];
  readonly errors: readonly PrometheusTextError[];
  readonly argumentCount: number;
}
type Unit = { readonly char: string; readonly start: number; readonly end: number }
  | { readonly slot: 'number' | 'quoted'; readonly argument: number; readonly start: number; readonly end: number };
const digit = (c: string): boolean => c >= '0' && c <= '9';
const letter = (c: string): boolean => c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z';
const nameStart = (c: string, metric: boolean): boolean => letter(c) || c === '_' || metric && c === ':';
const namePart = (c: string, metric: boolean): boolean => nameStart(c, metric) || digit(c);
const horizontal = (c: string): boolean => c === ' ' || c === '\t';

/** printf is explicit model metadata. It is not inferred from the literal or call spelling. */
export function parsePrometheusText(text: string, printf = false): PrometheusTextResult {
  const declarations: PrometheusTextDeclaration[] = [];
  const samples: PrometheusTextSample[] = [];
  const errors: PrometheusTextError[] = [];
  let argumentCount = 0;
  if (text.length > 1_048_576) return { declarations, samples, errors: [{ line: 1, column: 1, reason: 'exposition literal exceeds 1048576 characters' }], argumentCount };
  const lines: Unit[][] = [[]];
  let line = 1; let column = 1;
  for (let at = 0; at < text.length;) {
    const start = at; const char = text[at++]!;
    if (printf && char === '%') {
      if (text[at] === '%') { at++; lines[line - 1]!.push({ char: '%', start, end: at }); column += 2; continue; }
      // Explicit indexes and '*' consume arguments with different semantics: do not approximate them.
      while (at < text.length && '+-# 0'.includes(text[at]!)) at++;
      while (at < text.length && digit(text[at]!)) at++;
      if (text[at] === '.') { at++; while (at < text.length && digit(text[at]!)) at++; }
      const verb = text[at];
      if (verb === undefined || !'dfFeEgGq'.includes(verb)) {
        errors.push({ line, column, reason: 'unsupported printf directive in exposition literal' });
        return { declarations, samples, errors, argumentCount };
      }
      if (verb === 'q' && at !== start + 1) {
        errors.push({ line, column, reason: 'quoted label directive must be exactly %q' });
        return { declarations, samples, errors, argumentCount };
      }
      at++;
      lines[line - 1]!.push({ slot: verb === 'q' ? 'quoted' : 'number', argument: argumentCount++, start, end: at });
      column += at - start;
    } else if (char === '\n') { lines.push([]); line++; column = 1; }
    else { lines[line - 1]!.push({ char, start, end: at }); column++; }
  }
  for (let index = 0; index < lines.length; index++) {
    const units = lines[index]!; let pos = 0;
    const char = (): string => { const unit = units[pos]; return unit !== undefined && 'char' in unit ? unit.char : ''; };
    const whitespace = (): number => { const start = pos; while (horizontal(char())) pos++; return pos - start; };
    const fail = (reason: string): never => { throw new Error(reason); };
    const name = (metric: boolean): string => {
      if (!nameStart(char(), metric)) return fail(metric ? 'expected metric name' : 'expected label name');
      let result = char(); pos++; while (namePart(char(), metric)) { result += char(); pos++; } return result;
    };
    const number = (timestamp = false): number | undefined => {
      const unit = units[pos];
      if (!timestamp && unit !== undefined && 'slot' in unit && unit.slot === 'number') { pos++; return unit.argument; }
      if (char() === '+' || char() === '-') pos++;
      if (!timestamp) {
        for (const special of ['Inf', 'NaN']) {
          if (special.split('').every((c, i) => { const next = units[pos + i]; return next !== undefined && 'char' in next && next.char === c; })) {
            pos += special.length; return undefined;
          }
        }
      }
      let digits = 0; while (digit(char())) { pos++; digits++; }
      if (!timestamp && char() === '.') { pos++; while (digit(char())) { pos++; digits++; } }
      if (digits === 0) return fail(timestamp ? 'expected integer timestamp' : 'expected sample number');
      if (!timestamp && (char() === 'e' || char() === 'E')) {
        pos++; if (char() === '+' || char() === '-') pos++;
        let exponent = 0; while (digit(char())) { pos++; exponent++; }
        if (exponent === 0) return fail('expected exponent digits');
      }
      return undefined;
    };
    const quoted = (): number | undefined => {
      const unit = units[pos];
      if (unit !== undefined && 'slot' in unit && unit.slot === 'quoted') { pos++; return unit.argument; }
      if (char() !== '"') return fail('expected quoted label value');
      pos++;
      while (pos < units.length) {
        if (char() === '"') { pos++; return undefined; }
        if (char() === '\\') {
          pos++; if (!['\\', '"', 'n'].includes(char())) return fail('invalid label escape');
        } else if (char() === '' || char() === '\r') return fail('unsupported dynamic or control character in label');
        pos++;
      }
      return fail('unterminated label value');
    };
    const range = (): PrometheusTextRange => ({ start: units[0]?.start ?? 0, end: units[units.length - 1]?.end ?? 0, line: index + 1 });
    try {
      whitespace(); if (pos === units.length) continue;
      if (char() === '#') {
        pos++; whitespace();
        let directive = ''; while (letter(char())) { directive += char(); pos++; }
        if (directive !== 'TYPE' && directive !== 'HELP') continue;
        if (whitespace() === 0) fail('expected space after metadata directive');
        const metric = name(true);
        if (whitespace() === 0) fail('expected metadata value');
        let value = '';
        while (pos < units.length) {
          const unit = units[pos++]!; if (!('char' in unit)) fail('metadata must not depend on printf arguments');
          else value += unit.char;
        }
        if (directive === 'TYPE' && !['counter', 'gauge', 'histogram', 'summary', 'untyped'].includes(value.trim())) fail('invalid metric type');
        if (directive === 'HELP') {
          for (let at = 0; at < value.length; at++) if (value[at] === '\\') {
            at++; if (value[at] !== '\\' && value[at] !== 'n') fail('invalid HELP escape');
          }
        }
        declarations.push({ ...range(), name: metric, kind: directive === 'TYPE' ? 'type' : 'help', value: directive === 'TYPE' ? value.trim() : value });
        continue;
      }
      const metric = name(true); const labels: string[] = []; const labelArguments: number[] = [];
      if (char() === '{') {
        pos++; whitespace();
        if (char() !== '}') while (true) {
          const label = name(false); if (labels.includes(label)) fail('duplicate label name'); labels.push(label);
          whitespace(); if (char() !== '=') fail('expected label assignment'); pos++; whitespace();
          const argument = quoted(); if (argument !== undefined) labelArguments.push(argument);
          whitespace(); if (char() === '}') break;
          if (char() !== ',') fail('expected label separator'); pos++; whitespace(); if (char() === '}') break;
        }
        if (char() !== '}') fail('expected closing label brace'); pos++;
      }
      if (whitespace() === 0) fail('expected space before sample value');
      const valueArgument = number();
      if (pos < units.length) {
        if (whitespace() === 0) fail('unexpected characters after sample value');
        if (pos < units.length) { number(true); whitespace(); }
      }
      if (pos !== units.length) fail('unexpected characters after sample timestamp');
      samples.push({ ...range(), name: metric, labels, labelArguments, ...(valueArgument === undefined ? {} : { valueArgument }) });
    } catch (error) {
      errors.push({ line: index + 1, column: (units[pos]?.start ?? units[units.length - 1]?.end ?? 0) - (units[0]?.start ?? 0) + 1,
        reason: error instanceof Error ? error.message : String(error) });
    }
  }
  // A malformed line cannot silently yield a smaller positive document.
  return { declarations: errors.length === 0 ? declarations : [], samples: errors.length === 0 ? samples : [], errors, argumentCount };
}
