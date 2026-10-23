/** The lines of a byte stream, as they arrive: for the pipes a process and its child talk over. */
export async function* linesOf(stream: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let held = '';
  for await (const chunk of stream) {
    held += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let at = held.indexOf('\n');
    while (at >= 0) {
      const line = held.slice(0, at).replace(/\r$/, '');
      held = held.slice(at + 1);
      if (line !== '') yield line;
      at = held.indexOf('\n');
    }
  }
  held += decoder.decode();
  if (held.trim() !== '') yield held.trim();
}

/** The lines on this process's standard input. */
export function standardInputLines(): AsyncGenerator<string> {
  return linesOf(Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>);
}
