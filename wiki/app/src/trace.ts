/**
 * The page's own spans (decision 0039, item 22): a browser writes no trace file and the server has no
 * route that would take one, so a span is an entry of the page's performance timeline — the one the
 * browser's developer tools show — and its attributes are that entry's detail. The names and the
 * attributes are the engine's: what the call did, where, and how big the answer was.
 */
export type SpanAttributes = Readonly<Record<string, string | number | boolean>>;

/** What a span is while its work runs: the facts the work learns only when the call answers. */
export interface Span {
  setAttribute(name: string, value: string | number | boolean): void;
}

/** How many spans this page opened: each one gets a start mark of its own. */
let opened = 0;

/** Runs `work` inside one span: a start mark, the work, and the measure from that mark to now. */
export async function withSpan<T>(name: string, attributes: SpanAttributes, work: (span: Span) => Promise<T> | T): Promise<T> {
  opened += 1;
  const start = `madarch-span-${String(opened)}`;
  const detail: Record<string, string | number | boolean> = { ...attributes };
  performance.mark(start);
  try {
    return await work({ setAttribute: (attribute, value) => { detail[attribute] = value; } });
  } finally {
    performance.measure(name, { start, detail });
  }
}
