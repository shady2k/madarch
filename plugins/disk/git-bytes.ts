/** Git byte transport used by the repository metadata stages. */
function raise(message: string): never { throw new Error(message); }

/** The most bytes of git's standard error one failure may name; the rest is cut and said to be cut. */
const GIT_ERROR_BYTES = 4_000;

/**
 * Runs one git command in a checkout and hands its standard output to `onChunk`
 * as it arrives, so a history of a million entries is read once and never stands
 * in memory whole. The span names the command, its arguments and the bytes it
 * answered; it never holds those bytes.
 */
export async function gitStream(root: string, args: readonly string[], onChunk: (chunk: Uint8Array) => void, options: { readonly input?: string } = {}): Promise<number> {
    const executable = process.env['MADARCH_TOOL_GIT'] ?? raise('the declared system git tool is unavailable');
    const process_ = (() => {
    try {
      return Bun.spawn([executable, ...args], {
        cwd: root,
        stdin: options.input === undefined ? 'ignore' : new TextEncoder().encode(options.input),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
    } catch (error) {
      raise(`the repository at ${root} could not run "git ${args.join(' ')}": ${error instanceof Error ? error.message : String(error)}`);
    }
    })();
    const errors: Uint8Array[] = [];
    const drained = (async () => { for await (const chunk of process_.stderr as ReadableStream<Uint8Array>) errors.push(chunk); })();
    let bytes = 0;
    for await (const chunk of process_.stdout as ReadableStream<Uint8Array>) {
      bytes += chunk.byteLength;
      onChunk(chunk);
    }
    await drained;
    const code = await process_.exited;
    if (code !== 0) {
      const message = Buffer.concat(errors.map((one) => Buffer.from(one))).toString('utf8').trim();
      raise(`the repository at ${root} could not run "git ${args.join(' ')}": git exited ${String(code)}${message === '' ? '' : `: ${message.slice(0, GIT_ERROR_BYTES)}${message.length > GIT_ERROR_BYTES ? ' (cut)' : ''}`}`);
    }
    return bytes;
}

/** One git answer as text, for the small answers (a commit's tree id, a yes or a no). */
export async function gitText(root: string, args: readonly string[]): Promise<string> {
  const parts: Buffer[] = [];
  await gitStream(root, args, (chunk) => parts.push(Buffer.from(chunk)));
  return Buffer.concat(parts).toString('utf8');
}


const UTF8 = new TextDecoder('utf-8', { fatal: true });
function textOf(bytes: Uint8Array): string | undefined {
  try { return UTF8.decode(bytes); } catch { return undefined; }
}

/**
 * The bytes of many blobs as text, in one `git cat-file --batch` call (decision 0035, item 9: the files producer reads
 * the source, once per blob). A blob whose bytes are no UTF-8 is kept as no content, never as replacement characters;
 * the batch's own header states each object's size, so a content holding a line that looks like a header is read whole.
 */
export async function blobContents(root: string, blobs: readonly string[]): Promise<Map<string, string | null>> {
  const contents = new Map<string, string | null>();
  if (blobs.length === 0) return contents;
  const wanted = [...new Set(blobs)];
  let held = Buffer.alloc(0);
  let index = 0;
  const take = (chunk: Uint8Array): void => {
    held = held.length === 0 ? Buffer.from(chunk) : Buffer.concat([held, Buffer.from(chunk)]);
    for (;;) {
      if (index >= wanted.length) return;
      // A header is `<oid> <type> <size>` and a newline; the content follows, then its own newline.
      const newline = held.indexOf(0x0a);
      if (newline < 0) return;
      const header = held.subarray(0, newline).toString('latin1');
      const parts = header.split(' ');
      if (parts.length !== 3) { index += 1; held = held.subarray(newline + 1); continue; }
      const size = Number(parts[2]);
      if (!Number.isFinite(size) || held.length < newline + 1 + size + 1) return;
      const bytes = held.subarray(newline + 1, newline + 1 + size);
      contents.set(wanted[index]!, textOf(bytes) ?? null);
      held = held.subarray(newline + 1 + size + 1);
      index += 1;
    }
  };
  await gitStream(root, ['cat-file', '--batch'], (chunk) => take(chunk), { input: `${wanted.join('\n')}\n` });
  take(new Uint8Array(0));
  return contents;
}
