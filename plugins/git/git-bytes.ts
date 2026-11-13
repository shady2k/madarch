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

