/**
 * The model check's command line: `bun scripts/check-model.ts <repository
 * path> [--rev <git revision>] [--views <folder>] [--json]`. The check
 * itself lives in `src/check/model-check.ts`; this script only parses
 * arguments, prints and exits: 0 when nothing fails, 1 when something
 * fails, 2 when the repository or its model cannot be read. Errors are
 * printed first, then stale items, then problems — each with the ids of
 * the elements and relations involved — then warnings, then notes;
 * `--json` prints the same report as one JSON object. `--views`
 * names the folder every view of the model is rendered into when the
 * model compiles; without it nothing is written anywhere.
 */
import { checkModel } from '../src/check/model-check.js';

const USAGE = 'usage: bun scripts/check-model.ts <repository path> [--rev <git revision>] [--views <folder>] [--json]';

function main(args: readonly string[]): number {
  let repoPath: string | undefined;
  let rev: string | undefined;
  let views: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--rev') {
      rev = args[i + 1];
      if (rev === undefined) {
        console.error(USAGE);
        return 2;
      }
      i++;
    } else if (arg.startsWith('--rev=')) {
      rev = arg.slice('--rev='.length);
    } else if (arg === '--views') {
      views = args[i + 1];
      if (views === undefined) {
        console.error(USAGE);
        return 2;
      }
      i++;
    } else if (arg.startsWith('--views=')) {
      views = arg.slice('--views='.length);
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
    console.error(USAGE);
    return 2;
  }

  const report = checkModel(repoPath, { rev, views });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const finding of report.errors) console.log(`error: ${finding.file}:${finding.line}: ${finding.message}`);
    for (const finding of report.stale) console.log(`stale: ${finding.file}:${finding.line}: ${finding.message}`);
    for (const problem of report.problems) console.log(`problem ${problem.problem}: ${problem.message} (ids: ${problem.ids.join(', ')}) — method: ${problem.method}; source: ${problem.source}`);
    for (const finding of report.warnings) console.log(`warning: ${finding.file}:${finding.line}: ${finding.message}`);
    for (const finding of report.notes) console.log(`note: ${finding.file}:${finding.line}: ${finding.message}`);
  }
  return report.outcome === 'passed' ? 0 : report.outcome === 'failed' ? 1 : 2;
}

process.exitCode = main(process.argv.slice(2));
