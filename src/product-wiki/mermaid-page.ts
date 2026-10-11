/**
 * One rendered Mermaid page, split into the diagram source and the relation
 * table (feature E, madarch-iuc.15): the same split the static wiki's build
 * reads (src/wiki/build.ts mermaidOfPage), lifted here so the server's
 * architecture bundle reads the renderer's pages without building a site.
 * A page with no mermaid fence is a named error, never a silent skip.
 */

/** One Mermaid page's diagram source and relation table. */
export interface MermaidParts {
  /** The flowchart source, the init directive included. */
  readonly mermaid: string;
  /** The table under the diagram: the arrows by number. */
  readonly table: { readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] };
}

/** The fence's opening line, as the renderer writes it. */
const FENCE = '```mermaid\n';

/**
 * One Mermaid page's diagram source and relation table, exactly as
 * madarch's page carries them: the lines of its mermaid fence, and the
 * `|`-lines after it — a header row, a separator, one row per arrow. A
 * view with no arrows has no table, and the table stays empty then.
 */
export function mermaidOfPageText(content: string): MermaidParts {
  const open = content.indexOf(FENCE);
  if (open < 0) throw new Error('a rendered Mermaid page carries no mermaid fence');
  const from = open + FENCE.length;
  const close = content.indexOf('\n```', from);
  if (close < 0) throw new Error('a rendered Mermaid page carries an unterminated mermaid fence');
  const tableLines: string[] = [];
  for (const line of content.slice(close + 4).split('\n')) {
    if (!line.startsWith('|')) {
      if (tableLines.length > 0) break;
      continue;
    }
    tableLines.push(line);
  }
  const cells = (line: string): string[] =>
    line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((value) => value.replace(/\\([\\`*_\[\]<>|])/g, '$1').trim());
  return {
    mermaid: content.slice(from, close),
    table:
      tableLines.length < 2
        ? { columns: [], rows: [] }
        : { columns: cells(tableLines[0]!), rows: tableLines.slice(2).map(cells) },
  };
}
