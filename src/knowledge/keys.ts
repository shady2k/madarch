/**
 * The key shapes of the code graph the live readers name: a file and a symbol of it.
 * They were the extract driver's (`src/extract/code/keys.ts`) and stayed when the
 * driver went, because the writer's answers ask the graph for those entities
 * (madarch-8bdc.1.3).
 */

/** The graph key of one file of a repository. */
export function fileKey(path: string): string {
  return `code.file:${path}`;
}

/** The graph key of one symbol of a file: the path and the symbol's qualified name. */
export function symbolKey(path: string, qualifiedName: string): string {
  return `code.symbol:${path}#${qualifiedName}`;
}
