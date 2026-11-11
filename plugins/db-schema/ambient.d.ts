/**
 * The two parsers this plugin reads with, declared here because their published packages carry their typings in files
 * the plugin's closure does not hold: `@babel/parser` needs `@babel/types` for its declarations, and `libpg-query`
 * needs the generated types of `@pgsql/types`. The shapes below are the parts the plugin uses, named from the packages'
 * own declarations; the plugin's answer never depends on more of them.
 */
declare module '@babel/parser' {
  export interface Position { readonly line: number; readonly column: number; readonly index: number }
  export interface ParseOptions {
    readonly sourceType?: 'script' | 'module' | 'unambiguous';
    readonly plugins?: readonly string[];
    readonly errorRecovery?: boolean;
  }
  export function parse(input: string, options?: ParseOptions): unknown;
}

declare module 'libpg-query' {
  export interface ScanToken {
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly tokenType: number;
    readonly tokenName: string;
    readonly keywordKind: number;
    readonly keywordName: string;
  }
  export interface RawStatement {
    readonly stmt?: unknown;
    readonly stmt_location?: number;
    readonly stmt_len?: number;
  }
  export function loadModule(): Promise<void>;
  export function parseSync(query: string): { readonly stmts?: readonly RawStatement[] };
  export function scanSync(query: string): { readonly tokens?: readonly ScanToken[] };
}
