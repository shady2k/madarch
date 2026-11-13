/**
 * The one parser this plugin reads with, declared here because its published package carries its typings in files the
 * plugin's closure does not hold: `@babel/parser` needs `@babel/types` for its declarations. The shapes below are the
 * parts the plugin uses, named from the package's own declarations; the plugin's answer never depends on more of them.
 */
declare module '@babel/parser' {
  export interface ParseOptions {
    readonly sourceType?: 'script' | 'module' | 'unambiguous';
    readonly plugins?: readonly string[];
    readonly allowReturnOutsideFunction?: boolean;
    readonly allowAwaitOutsideFunction?: boolean;
    readonly errorRecovery?: boolean;
  }
  export function parse(input: string, options?: ParseOptions): unknown;
}
