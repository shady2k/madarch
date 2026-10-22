/**
 * A small highlighter for the code a source block and the source view show:
 * keywords, strings, comments and numbers, for the languages the training
 * product and most products are written in. No dependency: a scanner over the
 * line text, kept to what a reader needs to tell code from its words. The
 * palette is the wiki's graphite pair, so the kinds differ by weight and
 * posture (see `.tok-*` in styles/index.css).
 */

export type TokenKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number';
export type Token = { text: string; kind: TokenKind };

const C_LIKE = ['if', 'else', 'for', 'while', 'switch', 'case', 'default', 'break', 'continue', 'return', 'new', 'null', 'true', 'false', 'this', 'try', 'catch', 'finally', 'throw', 'in', 'of', 'typeof', 'instanceof', 'void'];

const KEYWORDS: Record<string, ReadonlySet<string>> = {
  typescript: new Set([...C_LIKE, 'import', 'export', 'from', 'as', 'const', 'let', 'var', 'function', 'class', 'extends', 'implements', 'interface', 'type', 'enum', 'async', 'await', 'public', 'private', 'protected', 'readonly', 'static', 'abstract', 'declare', 'namespace', 'undefined', 'super', 'yield', 'keyof']),
  javascript: new Set([...C_LIKE, 'import', 'export', 'from', 'as', 'const', 'let', 'var', 'function', 'class', 'extends', 'async', 'await', 'undefined', 'super', 'yield']),
  go: new Set(['package', 'import', 'func', 'return', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'go', 'defer', 'select', 'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'break', 'continue', 'fallthrough', 'goto', 'nil', 'true', 'false']),
  sql: new Set(['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'alter', 'drop', 'index', 'primary', 'key', 'foreign', 'references', 'not', 'null', 'default', 'unique', 'constraint', 'on', 'and', 'or', 'join', 'left', 'right', 'inner', 'group', 'by', 'order', 'limit', 'as', 'check', 'begin', 'commit']),
  prisma: new Set(['model', 'datasource', 'generator', 'enum', 'type']),
  protobuf: new Set(['syntax', 'package', 'import', 'service', 'rpc', 'returns', 'message', 'enum', 'repeated', 'optional', 'oneof', 'option']),
  shell: new Set(['if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'function', 'export', 'echo', 'set']),
};

type Rules = { line: string | null; block: [string, string] | null; strings: string; keywordsFold: boolean };

const RULES: Record<string, Rules> = {
  typescript: { line: '//', block: ['/*', '*/'], strings: '\'"`', keywordsFold: false },
  javascript: { line: '//', block: ['/*', '*/'], strings: '\'"`', keywordsFold: false },
  go: { line: '//', block: ['/*', '*/'], strings: '"`\'', keywordsFold: false },
  sql: { line: '--', block: ['/*', '*/'], strings: '\'"', keywordsFold: true },
  prisma: { line: '//', block: null, strings: '"', keywordsFold: false },
  protobuf: { line: '//', block: ['/*', '*/'], strings: '"\'', keywordsFold: false },
  shell: { line: '#', block: null, strings: '"\'', keywordsFold: false },
  yaml: { line: '#', block: null, strings: '"\'', keywordsFold: false },
  toml: { line: '#', block: null, strings: '"\'', keywordsFold: false },
  dockerfile: { line: '#', block: null, strings: '"\'', keywordsFold: false },
  makefile: { line: '#', block: null, strings: '"\'', keywordsFold: false },
  json: { line: null, block: null, strings: '"', keywordsFold: false },
};

/**
 * The lines of a code text as token runs. A comment or string that spans lines
 * carries its kind to the next line, so a block comment is told on every line.
 */
export function highlight(text: string, language: string): Token[][] {
  const lines = text.split('\n');
  const rules = RULES[language];
  const keywords = KEYWORDS[language];
  if (rules === undefined) return lines.map((line) => [{ text: line, kind: 'plain' }]);
  let open: { kind: 'comment' | 'string'; end: string } | null = null;
  return lines.map((line) => {
    const out: Token[] = [];
    const push = (kind: TokenKind, piece: string): void => {
      if (piece === '') return;
      const last = out[out.length - 1];
      if (last !== undefined && last.kind === kind) last.text += piece;
      else out.push({ text: piece, kind });
    };
    let at = 0;
    while (at < line.length) {
      if (open !== null) {
        const end = line.indexOf(open.end, at);
        if (end < 0) {
          push(open.kind, line.slice(at));
          at = line.length;
        } else {
          push(open.kind, line.slice(at, end + open.end.length));
          at = end + open.end.length;
          open = null;
        }
        continue;
      }
      const rest = line.slice(at);
      if (rules.line !== null && rest.startsWith(rules.line)) {
        push('comment', rest);
        break;
      }
      if (rules.block !== null && rest.startsWith(rules.block[0])) {
        open = { kind: 'comment', end: rules.block[1] };
        push('comment', rules.block[0]);
        at += rules.block[0].length;
        continue;
      }
      const quote = rest[0]!;
      if (rules.strings.includes(quote)) {
        let end = at + 1;
        while (end < line.length && line[end] !== quote) end += line[end] === '\\' ? 2 : 1;
        if (end >= line.length) {
          // a template or raw string runs on; any other string ends with its line
          if (quote === '`') open = { kind: 'string', end: '`' };
          push('string', line.slice(at));
          at = line.length;
        } else {
          push('string', line.slice(at, end + 1));
          at = end + 1;
        }
        continue;
      }
      const word = /^[A-Za-z_$][\w$]*/.exec(rest);
      if (word !== null) {
        const candidate = rules.keywordsFold ? word[0].toLowerCase() : word[0];
        push(keywords?.has(candidate) === true ? 'keyword' : 'plain', word[0]);
        at += word[0].length;
        continue;
      }
      const number = /^\d[\d_.]*(?:e[+-]?\d+)?/i.exec(rest);
      if (number !== null) {
        push('number', number[0]);
        at += number[0].length;
        continue;
      }
      push('plain', quote);
      at += 1;
    }
    return out.length === 0 ? [{ text: '', kind: 'plain' as const }] : out;
  });
}
