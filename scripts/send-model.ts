/**
 * The send command's command line: `bun scripts/send-model.ts
 * <repository path> --server <url> [--source <name>] [--rev <git
 * revision>]`. The model check runs first, as `check-model.ts` runs it,
 * and only a passing check is sent: the compiled model, with the source's
 * name (`--source`, else the `origin` remote as host and path), the
 * revision's commit id and its committer time, to `POST <server>/models`.
 * Exits 0 printing the source, the commit and whether it was stored or
 * was already stored; 1 when the check fails, printing its findings; 2
 * naming what is missing — a flag, a source name, a readable repository
 * or revision, a reachable server — or printing the server's refusal.
 * The origin remote's credentials never reach the output or the request.
 */
import { sendModel } from '../src/send/send-model.js';
import type { ModelCheckReport } from '../src/check/model-check.js';

const USAGE = 'usage: bun scripts/send-model.ts <repository path> --server <url> [--source <name>] [--rev <git revision>]';

/** The check's findings, printed as `check-model.ts` prints them. */
function printFindings(report: ModelCheckReport): void {
  for (const finding of report.errors) console.log(`error: ${finding.file}:${finding.line}: ${finding.message}`);
  for (const finding of report.stale) console.log(`stale: ${finding.file}:${finding.line}: ${finding.message}`);
  for (const problem of report.problems) console.log(`problem ${problem.problem}: ${problem.message} (ids: ${problem.ids.join(', ')}) — method: ${problem.method}; source: ${problem.source}`);
  for (const finding of report.warnings) console.log(`warning: ${finding.file}:${finding.line}: ${finding.message}`);
  for (const finding of report.notes) console.log(`note: ${finding.file}:${finding.line}: ${finding.message}`);
}

async function main(args: readonly string[]): Promise<number> {
  let repoPath: string | undefined;
  let server: string | undefined;
  let source: string | undefined;
  let rev: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--server' || arg === '--source' || arg === '--rev') {
      const value = args[i + 1];
      if (value === undefined) {
        console.error(`the ${arg} flag needs a value`);
        console.error(USAGE);
        return 2;
      }
      if (arg === '--server') server = value;
      else if (arg === '--source') source = value;
      else rev = value;
      i++;
    } else if (arg.startsWith('--server=')) {
      server = arg.slice('--server='.length);
    } else if (arg.startsWith('--source=')) {
      source = arg.slice('--source='.length);
    } else if (arg.startsWith('--rev=')) {
      rev = arg.slice('--rev='.length);
    } else if (arg.startsWith('--')) {
      console.error(`unknown option "${arg}"`);
      console.error(USAGE);
      return 2;
    } else if (repoPath === undefined) {
      repoPath = arg;
    } else {
      console.error(`unexpected argument "${arg}"`);
      console.error(USAGE);
      return 2;
    }
  }
  if (repoPath === undefined) {
    console.error('the repository path is required: it names the checkout whose model is sent');
    console.error(USAGE);
    return 2;
  }
  if (server === undefined) {
    console.error('the --server flag is required: it names the address of the madarch server to send to');
    console.error(USAGE);
    return 2;
  }
  try {
    new URL(server);
  } catch {
    console.error('the --server flag is not a URL, like http://127.0.0.1:4180');
    console.error(USAGE);
    return 2;
  }

  const result = await sendModel({ repoPath, server, source, rev });
  switch (result.outcome) {
    case 'stored':
      console.log(`stored ${result.source} at ${result.commit}`);
      return 0;
    case 'already-stored':
      console.log(`already stored ${result.source} at ${result.commit}`);
      return 0;
    case 'check-failed':
      printFindings(result.report);
      return 1;
    case 'unreadable':
      printFindings(result.report);
      return 2;
    case 'no-source-name':
    case 'revision-unreadable':
    case 'no-model':
      console.error(`error: ${result.problem}`);
      return 2;
    case 'unreachable':
      console.error(`error: the server at ${result.server} could not be reached: ${result.cause}`);
      return 2;
    case 'refused': {
      const field = result.field === undefined ? '' : ` (field: ${result.field})`;
      console.error(`error: ${result.message}${field}`);
      return 2;
    }
    case 'bad-answer':
      console.error(`error: the server answered ${result.status} with something that is not an answer to a send: ${result.problem}`);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
