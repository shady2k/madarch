/**
 * `madarch mcp` (madarch-ztyq.10): the command that serves one checkout's graph
 * to an agent over the Model Context Protocol, and the command that reads the
 * journal of what was served.
 *
 *     madarch mcp [--repo <path>]   serve over standard input and output
 *     madarch mcp --journal         print what the last calls cost and saved
 *
 * `--repo` is the checkout to serve and is the current folder when left out.
 * The graph and the journal live in the one store the wiki's button fills —
 * `<products home>/.madarch/knowledge/<product id>`, its graph at
 * `<store>/graph` — so a server reads what a fill published and publishes what
 * the button and `madarch fill` read. `--journal` reads that store's journal
 * and answers the summary without starting a server, so it can be asked while
 * another server runs.
 */
import { resolve } from 'node:path';
import { readRevision } from './git.js';
import { repositoryStoreFolder } from './graph.js';
import { summarize, summaryLines } from './journal.js';
import { serveRepositoryMcp } from './server.js';

/** What `madarch mcp` was asked to do. */
export interface McpArguments {
  readonly repository: string;
  readonly journal: boolean;
  readonly help: boolean;
}

/** How the command is read: two flags with a value, two without, and the rule for anything else. */
export function parseMcpArgs(args: readonly string[], cwd: string = process.cwd(), env: Readonly<Record<string, string | undefined>> = process.env): McpArguments | string {
  let repository: string | undefined;
  let journal = false;
  let help = false;
  for (let at = 0; at < args.length; at += 1) {
    const flag = args[at]!;
    const take = (name: string): { value: string } | { error: string } => {
      const next = args[at + 1];
      if (next === undefined || next.trim() === '') return { error: `${name} takes a path, and none follows it` };
      at += 1;
      return { value: next };
    };
    if (flag === '--repo') {
      const read = take(flag);
      if ('error' in read) return read.error;
      repository = read.value;
    } else if (flag === '--journal') {
      journal = true;
    } else if (flag === '--help' || flag === '-h') {
      help = true;
    } else {
      return `${JSON.stringify(flag)} is no flag of madarch mcp: the flags are --repo <path>, --journal and --help`;
    }
  }
  const absolute = resolve(cwd, repository ?? '.');
  return { repository: absolute, journal, help };
}

/** The command's own help, printed for `--help` and for a flag it does not know. */
export const MCP_USAGE = [
  'usage: madarch mcp [--repo <path>]',
  '       madarch mcp --journal [--repo <path>]',
  '',
  'Serves one git checkout\'s graph to an agent over the Model Context Protocol on',
  'standard input and output: initialize, tools/list, tools/call. The tools of this',
  'step read the repository graph only — list_files, get_file, get_file_history,',
  'get_commit, get_repository — and every answer names the as-is commit it is true',
  'at and the paths the working tree changed. The seven tools of decision 0032 are',
  'served beside them and answer that their step has not run, naming the step.',
  '',
  '  --repo <path>      the checkout to serve (default: the current folder)',
  '  --journal          print what the served calls cost and saved, and exit',
  '  --help, -h         print this text and exit',
  '',
  'The graph is built on the first start (its progress is said on standard error)',
  'and kept, so the next start reads it.',
].join('\n');

/** `madarch mcp`: serve, or print the journal, and answer the exit code. */
export async function mcpCommand(args: readonly string[], options: {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: { write(text: string): void };
  readonly stderr?: { write(text: string): void };
  readonly input?: AsyncIterable<string | Uint8Array>;
} = {}): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const parsed = parseMcpArgs(args, options.cwd ?? process.cwd(), env);
  if (typeof parsed === 'string') {
    stderr.write(`madarch mcp: ${parsed}\n${MCP_USAGE}\n`);
    return 2;
  }
  if (parsed.help) {
    stdout.write(`${MCP_USAGE}\n`);
    return 0;
  }
  let folder: string;
  try {
    // The store is named by the checkout's product id (or its folder's name): a folder that names no store is refused by name.
    folder = repositoryStoreFolder(parsed.repository, env);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (parsed.journal) {
    for (const line of summaryLines(summarize(folder))) stdout.write(`${line}\n`);
    return 0;
  }
  try {
    readRevision(parsed.repository);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    return await serveRepositoryMcp({
      repository: parsed.repository,
      env,
      ...(options.input === undefined ? {} : { input: options.input }),
      output: stdout,
      errorOutput: stderr,
    });
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
