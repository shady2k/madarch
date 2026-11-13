/**
 * `madarch mcp`: the product's one MCP session (decision 0036, sections 2 and 8): `graph_schema`, `graph_query` and the
 * agent's graph writes, over standard input and output. The repository graph tools are gone with the page layer; the
 * graph is read and written through this session only.
 *
 *     madarch mcp [--product <folder>] [--home <folder>]
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serveProductMcp } from './authored.js';
import { entityProductFolder } from '../product/entity-cli.js';
import { productsHome, type DraftEnv } from '../product/home.js';
import { withDaemonStorePreparation, withStorePreparationOwner } from '../product/store-preparation.js';
import { whereAmI } from '../product/lifecycle.js';

interface McpArguments {
  readonly repository: string;
  readonly product?: string;
  readonly home?: string;
  readonly help: boolean;
}

function parseMcpArgs(args: readonly string[], cwd: string = process.cwd()): McpArguments | string {
  let product: string | undefined;
  let home: string | undefined;
  let help = false;
  for (let at = 0; at < args.length; at += 1) {
    const flag = args[at]!;
    if (flag === '--product' || flag === '--home') {
      const next = args[at + 1];
      if (next === undefined || next.trim() === '' || next.startsWith('--')) return `${flag} takes a path, and none follows it`;
      at += 1;
      if (flag === '--product') product = resolve(cwd, next);
      else home = resolve(cwd, next);
    } else if (flag === '--help' || flag === '-h') {
      help = true;
    } else {
      return `${JSON.stringify(flag)} is no flag of madarch mcp: the flags are --product <path>, --home <path> and --help`;
    }
  }
  return { repository: resolve(cwd, '.'), ...(product === undefined ? {} : { product }), ...(home === undefined ? {} : { home }), help };
}

const MCP_USAGE = [
  'usage: madarch mcp [--product <folder>] [--home <folder>]',
  '',
  'Serves one product graph to an agent over the Model Context Protocol: graph_schema, graph_query and the agent\'s',
  'writes (put_entity, put_edge, retract). A write names its evidence; its source is agent:<client>@<session>, so the',
  'agent and the plugins meet as opinions on one field (decision 0036, section 2). No tool runs a fill.',
  '',
  '  --product <path>  the product folder (the current folder when left out)',
  '  --home <path>     the products home',
  '  --help, -h        print this text and exit',
].join('\n');

export async function mcpCommand(args: readonly string[], options: { readonly input?: AsyncIterable<string | Uint8Array>; readonly output?: { write(text: string): void }; readonly env?: Readonly<Record<string, string | undefined>> } = {}): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.output ?? { write: (text: string) => { process.stdout.write(text); } };
  const stderr = { write: (text: string) => { process.stderr.write(text); } };
  const parsed = parseMcpArgs(args);
  if (typeof parsed === 'string') { stderr.write(`madarch mcp: ${parsed}\n`); return 2; }
  if (parsed.help) { stdout.write(`${MCP_USAGE}\n`); return 0; }
  const context = whereAmI({ folder: parsed.repository });
  if (parsed.product === undefined && context.outcome !== 'product' && context.outcome !== 'code') {
    stderr.write(`madarch mcp: ${parsed.repository} is no product folder: give --product <folder>\n`); return 2;
  }
  try {
    const productFolder = entityProductFolder(parsed.product, parsed.repository);
    const home = productsHome(env as DraftEnv, parsed.home);
    const serve = async (): Promise<number> => await serveProductMcp({
      productFolder, env,
      ...(parsed.home === undefined ? {} : { home: parsed.home }),
      ...(options.input === undefined ? {} : { input: options.input }), output: stdout,
    });
    // A store's schema is prepared by its owning process: borrow a running daemon's service, or own the preparation.
    return existsSync(join(home, '.madarch-store-owner.json'))
      ? await withDaemonStorePreparation(home, serve)
      : await withStorePreparationOwner(serve);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
