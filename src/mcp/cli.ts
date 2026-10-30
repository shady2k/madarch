/**
 * `madarch mcp` (madarch-ztyq.10): the command that serves one checkout's graph
 * to an agent over the Model Context Protocol, and the command that reads the
 * journal of what was served.
 *
 *     madarch mcp [--repo <path>] [--store <folder>]   serve over standard input and output
 *     madarch mcp --journal [--repo <path>]            print what the last calls cost and saved
 *
 * `--repo` is the checkout to serve and is the current folder when left out.
 * `--store` names the folder the graph and the journal are kept in; without it
 * the folder is the state root's own (`$XDG_STATE_HOME/madarch/mcp`), one per
 * repository. `--journal` reads that folder's journal and answers the summary
 * without starting a server, so it can be asked while another server runs.
 */
import { resolve } from 'node:path';
import { readRevision } from './git.js';
import { graphFolder, mcpStateRoot } from './graph.js';
import { summarize, summaryLines } from './journal.js';
import { serveRepositoryMcp } from './server.js';

/** What `madarch mcp` was asked to do. */
export interface McpArguments {
  readonly repository: string;
  readonly folder: string | undefined;
  readonly journal: boolean;
  readonly help: boolean;
}

/** How the command is read: two flags with a value, two without, and the rule for anything else. */
export function parseMcpArgs(args: readonly string[], cwd: string = process.cwd(), env: Readonly<Record<string, string | undefined>> = process.env): McpArguments | string {
  let repository: string | undefined;
  let folder: string | undefined;
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
    } else if (flag === '--store') {
      const read = take(flag);
      if ('error' in read) return read.error;
      folder = read.value;
    } else if (flag === '--journal') {
      journal = true;
    } else if (flag === '--help' || flag === '-h') {
      help = true;
    } else {
      return `${JSON.stringify(flag)} is no flag of madarch mcp: the flags are --repo <path>, --store <folder>, --journal and --help`;
    }
  }
  const absolute = resolve(cwd, repository ?? '.');
  return { repository: absolute, folder: folder === undefined ? undefined : resolve(cwd, folder), journal, help };
}

/** The command's own help, printed for `--help` and for a flag it does not know. */
export const MCP_USAGE = [
  'usage: madarch mcp [--repo <path>] [--store <folder>]',
  '       madarch mcp --journal [--repo <path>] [--store <folder>]',
  '',
  'Serves one git checkout\'s graph to an agent over the Model Context Protocol on',
  'standard input and output: initialize, tools/list, tools/call. The tools are the',
  'seven of decision 0032 — get_symbol, get_context, trace_flow,',
  'get_document_sections, search_pages, get_page, search_questions — read-only,',
  'with the working tree\'s uncommitted edits preferred to the commit\'s facts, and',
  'every answer naming the commit and the changed files it was read at.',
  '',
  '  --repo <path>      the checkout to serve (default: the current folder)',
  '  --store <folder>   where the graph and the journal are kept (default: the',
  '                     state root\'s own folder per repository)',
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
  const folder = parsed.folder ?? graphFolder(parsed.repository, mcpStateRoot(env));
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
  return await serveRepositoryMcp({
    repository: parsed.repository,
    folder,
    env,
    ...(options.input === undefined ? {} : { input: options.input }),
    output: stdout,
    errorOutput: stderr,
  });
}
