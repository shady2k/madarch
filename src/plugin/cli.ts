/**
 * `madarch plugin check <dir>` and `madarch plugin run <dir> …` (decision
 * 0035, item 8): the conformance kit and the local runner, and the production
 * callers of the plugin host. `check` holds a plugin to the protocol and its
 * own contract inside the sandbox and publishes nothing; `run` executes the
 * units a caller names and prints the results the host validated.
 *
 * The run's scratch folder holds its trace and logs — every host decision and
 * every iteration writes a span and a line there — and is printed when the
 * command starts. Anonymous scratch folders are removed when the command ends;
 * use --work to keep the trace and logs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { Value } from 'typebox/value';
import { byCodePoint } from '../model/order.js';
import { closeTrace, openTrace, runInTrace } from '../obs/trace.js';
import { checkConformance, describeOutcome, type ConformanceReport } from './conformance.js';
import { runUnits, type RunnerUnit, type PluginRunResult } from './host.js';
import { PluginUnitRequest, type PluginUnitRequest as UnitRequest } from './protocol.js';

/** What the two commands share: the plugin folder, the run's scratch folder and the run's words. */
interface PluginOptions {
  readonly verb: 'check' | 'run';
  readonly folder: string;
  readonly repository: string | undefined;
  readonly units: readonly UnitRequest[];
  readonly work: string | undefined;
  readonly json: boolean;
  readonly plugins: number;
  readonly unitsPerPlugin: number;
}

const USAGE = [
  'usage: madarch plugin check <dir> [--repo <path>] [--unit <json>] [--work <folder>] [--json]',
  '   or: madarch plugin run <dir> --repo <path> --unit <json> [--unit <json>] [--plugins <n>] [--units-per-plugin <n>] [--work <folder>] [--json]',
  '',
  'check runs the conformance kit: the plugin introduces itself, answers a unit (the one given, or one',
  'built from its declaration), stays alive through a pause longer than the heartbeat deadline, and',
  'exits on stop. It runs in the sandbox and publishes nothing; a closure no release carries may run',
  'here, and only here.',
  '',
  'run executes the units given, each held against the plugin\'s declaration, in the sandbox, and',
  'prints what the host validated. --plugins bounds the plugins at once and --units-per-plugin the',
  'units one plugin is given at a time (the smaller of it and what the plugin declared).',
  '',
  'The run\'s scratch folder holds its trace and the plugin\'s standard error; it is printed first.',
  'Anonymous scratch folders are removed when the command ends. Use --work to keep trace and logs.',
].join('\n');

/** One refusal of the command line: what is wrong, and the exit it needs. */
function refuse(message: string, exit = 2): number {
  console.error(`${message}\nrun madarch plugin --help for help`);
  return exit;
}

/** Parses the two commands' words; a `--flag value` needs its value and takes one. */
function parse(args: readonly string[]): PluginOptions | number {
  const verb = args[0];
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  if (verb !== 'check' && verb !== 'run') return refuse(`madarch plugin takes "check" or "run", and was given ${verb === undefined ? 'nothing' : JSON.stringify(verb)}`);
  const words: string[] = [];
  const units: UnitRequest[] = [];
  let repository: string | undefined;
  let work: string | undefined;
  let json = false;
  let plugins = 1;
  let unitsPerPlugin = 1;
  for (let at = 1; at < args.length; at += 1) {
    const arg = args[at]!;
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined;
    const value = (): string | undefined => {
      if (inline !== undefined) return inline;
      const next = args[at + 1];
      if (next === undefined || next.startsWith('--')) return undefined;
      at += 1;
      return next;
    };
    if (name === '--json') { json = true; continue; }
    if (name === '--repo') {
      const given = value();
      if (given === undefined || given.trim() === '') return refuse('--repo needs the path of the repository the plugin may read');
      repository = given;
      continue;
    }
    if (name === '--work') {
      const given = value();
      if (given === undefined || given.trim() === '') return refuse('--work needs the folder the run\'s trace and logs live in');
      work = given;
      continue;
    }
    if (name === '--unit') {
      const given = value();
      if (given === undefined || given.trim() === '') return refuse('--unit needs one unit as JSON, like {"unitId":"u1","kind":"file","key":{"path":"a.ts"}}');
      let parsed: unknown;
      try {
        parsed = JSON.parse(given);
      } catch (error) {
        return refuse(`--unit ${JSON.stringify(given)} is not JSON: ${(error as Error).message}`);
      }
      if (!Value.Check(PluginUnitRequest, parsed)) {
        const first = [...Value.Errors(PluginUnitRequest, parsed)][0];
        return refuse(`--unit ${JSON.stringify(given)} is not a unit: ${first === undefined ? 'it does not fit the protocol' : `${first.instancePath === '' ? 'the unit' : first.instancePath.slice(1)}: ${first.message}`}`);
      }
      units.push(parsed);
      continue;
    }
    if (name === '--plugins' || name === '--units-per-plugin') {
      const given = value();
      const number = given === undefined ? Number.NaN : Number(given);
      if (!Number.isInteger(number) || number < 1 || number > 64) return refuse(`${name} ${JSON.stringify(given ?? '')} is not a whole number from 1 through 64: it bounds what runs at once`);
      if (name === '--plugins') plugins = number;
      else unitsPerPlugin = number;
      continue;
    }
    return refuse(`unknown option ${JSON.stringify(arg)}: the options are --repo, --unit, --work, --plugins, --units-per-plugin and --json`);
  }
  if (words.length !== 1) return refuse(`madarch plugin ${verb} takes one word, the plugin folder, and was given ${words.length === 0 ? 'none' : words.join(' ')}`);
  const folder = resolve(words[0]!);
  if (verb === 'run' && repository === undefined) return refuse('madarch plugin run needs --repo: the repository the plugin reads, bound read-only');
  if (verb === 'run' && units.length === 0) return refuse('madarch plugin run needs at least one --unit: the units the plugin executes');
  const workFolder = work === undefined ? undefined : resolve(work);
  return { verb, folder, repository, units, work: workFolder, json, plugins, unitsPerPlugin };
}

/** Prints a check's report: its lines, then one answer for the whole run. */
function reportCheck(report: ConformanceReport, json: boolean, work: string): number {
  if (json) {
    console.log(JSON.stringify({ work, ok: report.ok, lines: report.lines }));
    return report.ok ? 0 : 1;
  }
  for (const line of report.lines) console.log(`${line.ok ? 'ok  ' : 'fail'} ${line.text}`);
  console.log(report.ok ? 'check: conforms' : 'check: does not conform');
  return report.ok ? 0 : 1;
}

/** Prints one plugin's units: each outcome in the kit's words, and the closure that ran. */
function reportRun(results: readonly PluginRunResult[], json: boolean, work: string): number {
  const failed = results.some((result) => result.units.some((outcome) => outcome.state === 'not-extracted'));
  if (json) {
    console.log(JSON.stringify({ work, ok: !failed, plugins: results }));
    return failed ? 1 : 0;
  }
  for (const result of results) {
    console.log(`plugin ${result.pluginFolder} (closure ${result.closureHash})`);
    for (const outcome of [...result.units].sort((left, right) => byCodePoint(left.unitId, right.unitId))) console.log(`  ${describeOutcome(outcome).text}`);
  }
  return failed ? 1 : 0;
}

/** The command: `check` or `run`, its scratch folder's trace opened first and closed whatever the outcome. */
export async function pluginCommand(args: readonly string[]): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    console.log(USAGE);
    return 0;
  }
  const parsed = parse(args);
  if (typeof parsed === 'number') return parsed;
  let work: string | undefined;
  let trace: ReturnType<typeof openTrace> | undefined;
  try {
    work = parsed.work ?? mkdtempSync(join(os.tmpdir(), 'madarch-plugin-'));
    trace = openTrace({ store: work, runId: `plugin-${parsed.verb}-${String(process.pid)}` });
    const workRoot = work;
    return await runInTrace(trace, async () => {
      console.log(`work: ${workRoot}`);
      if (parsed.verb === 'check') {
        const report = await checkConformance({
          pluginFolder: parsed.folder,
          ...(parsed.repository === undefined ? {} : { repository: parsed.repository }),
          workRoot,
          ...(parsed.units.length === 0 ? {} : { units: parsed.units }),
          ...(process.env['MADARCH_PLUGIN_CGROUP'] === undefined ? {} : { cgroupParent: process.env['MADARCH_PLUGIN_CGROUP'] }),
        });
        return reportCheck(report, parsed.json, workRoot);
      }
      const work: RunnerUnit[] = parsed.units.map((unit) => ({ pluginFolder: parsed.folder, unit }));
      const results = await runUnits({
        repository: parsed.repository!,
        workRoot,
        trust: 'production',
        settings: { pluginsAtOnce: parsed.plugins, unitsPerPlugin: parsed.unitsPerPlugin },
        ...(process.env['MADARCH_PLUGIN_CGROUP'] === undefined ? {} : { cgroupParent: process.env['MADARCH_PLUGIN_CGROUP'] }),
      }, work);
      return reportRun(results, parsed.json, workRoot);
    });
  } catch (error) {
    const failed = error as Error & { code?: string; file?: string; line?: number };
    console.error(`${failed.file === undefined ? 'src/plugin/cli.ts:1' : `${failed.file}:${String(failed.line ?? 1)}`}: ${failed.code === undefined ? '' : `${failed.code}: `}${failed.message}`);
    return 1;
  } finally {
    try {
      if (trace !== undefined) closeTrace(trace);
    } finally {
      if (parsed.work === undefined && work !== undefined) rmSync(work, { recursive: true, force: true });
    }
  }
}
