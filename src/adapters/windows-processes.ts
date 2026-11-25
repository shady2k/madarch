import { spawnSync } from 'node:child_process';
import { withSpanSync } from '../obs/trace.js';

export interface WindowsProcess {
  pid: number;
  parent: number;
  name: string;
  commandLine: string;
  created?: number;
}

export interface WindowsEndResult {
  held: number[];
  left: number[];
  processes: WindowsProcess[];
}

const CREATED_FIELD = "@{n='Created';e={if($_.CreationDate){[long](($_.CreationDate.ToFileTimeUtc()-116444736000000000)/10)}}}";
const PROCESS_QUERY = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,${CREATED_FIELD}`;

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Parses JSON output from `Win32_Process` CIM queries (single object or array) into normalized rows. */
export function parseWindowsProcessRows(value: unknown): WindowsProcess[] {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (typeof item !== 'object' || item === null) throw new Error('Invalid Windows process row');
    const row = item as Record<string, unknown>;
    if (!isNonNegativeSafeInt(row.ProcessId)) throw new Error(`Invalid Windows ProcessId: ${String(row.ProcessId)}`);
    if (!isNonNegativeSafeInt(row.ParentProcessId)) throw new Error(`Invalid Windows ParentProcessId: ${String(row.ParentProcessId)}`);
    const created = isPositiveSafeInt(row.Created) ? row.Created : undefined;
    return {
      pid: row.ProcessId,
      parent: row.ParentProcessId,
      name: typeof row.Name === 'string' ? row.Name : '',
      commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : '',
      ...(created !== undefined ? { created } : {}),
    };
  });
}

function parsePidArray(value: unknown): number[] {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!isPositiveSafeInt(item)) throw new Error(`Invalid Windows process id in result: ${String(item)}`);
    return item;
  });
}

interface SpawnResult {
  error?: Error;
  status: number | null | undefined;
  signal?: NodeJS.Signals | null;
  pid?: number;
  stdout: string | null;
  stderr: string | null;
}

type SpawnRunner = (
  command: string,
  args: readonly string[],
  options: { encoding: 'utf8'; timeout: number },
) => SpawnResult;

function didNotStart(result: SpawnResult): boolean {
  if (!result.error) return false;
  if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') return false;
  return result.status === null || result.status === undefined;
}

function runPowerShell<T>(
  script: string,
  parse: (stdout: string) => T,
  retryStarted: boolean,
  run: SpawnRunner = spawnSync,
): T | undefined {
  for (const program of ['powershell', 'pwsh']) {
    const args = ['-NoProfile', '-NonInteractive', '-Command', script];
    const result = withSpanSync('process.run', { 'process.command': program, 'process.args': args }, (span) => {
      const answer = run(program, args, { encoding: 'utf8', timeout: 15_000 });
      span.setAttribute('process.exit_code', answer.status ?? -1);
      span.setAttribute('process.stdout.bytes', Buffer.byteLength(answer.stdout ?? ''));
      span.setAttribute('process.stderr.bytes', Buffer.byteLength(answer.stderr ?? ''));
      return answer;
    });
    if (result.error || result.status !== 0) {
      if (!retryStarted && !didNotStart(result)) return undefined;
      continue;
    }
    try { return parse(result.stdout ?? ''); }
    catch {
      /* A failed process listing is not evidence that the tree is gone. */
      if (!retryStarted) return undefined;
    }
  }
  return undefined;
}

/** Lists Windows processes with command lines and Unix microsecond creation times; undefined if unreadable. */
export function listWindowsProcesses(run: SpawnRunner = spawnSync): WindowsProcess[] | undefined {
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ${PROCESS_QUERY} | ConvertTo-Json -Compress -Depth 4`;
  return runPowerShell(script, (stdout) => {
    const processes = parseWindowsProcessRows(JSON.parse(stdout));
    if (processes.length === 0) throw new Error('Empty Windows process snapshot');
    return processes;
  }, true, run);
}

/**
 * Verifies each target's start time on an open kernel handle before killing (preventing PID reuse),
 * waits up to 5 s, and lists processes while the handles remain open.
 */
export function endWindowsProcesses(
  targets: readonly { pid: number; created: number }[],
  run: SpawnRunner = spawnSync,
): WindowsEndResult | undefined {
  for (const target of targets) {
    if (!isPositiveSafeInt(target.pid) || !isPositiveSafeInt(target.created)) {
      throw new RangeError(`Invalid Windows process target: pid=${String(target.pid)}, created=${String(target.created)}`);
    }
  }
  if (targets.length === 0) {
    const processes = listWindowsProcesses(run);
    return processes === undefined ? undefined : { held: [], left: [], processes };
  }
  const pairs = targets.map((target) => `'${String(target.pid)}:${String(target.created)}'`).join(',');
  const script = [
    "$ErrorActionPreference='Stop'",
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    '$held=@()',
    '$heldIds=@()',
    'try{',
    `foreach($t in @(${pairs})){`,
    "$id,$at=$t.Split(':')",
    '$p=$null',
    'try{',
    '$p=[Diagnostics.Process]::GetProcessById([int]$id)',
    '$null=$p.Handle',
    'if([Math]::Abs(($p.StartTime.ToFileTimeUtc()-116444736000000000)/10-[long]$at) -le 1000){$held+=$p;$heldIds+=$p.Id;$p=$null}',
    '}catch{}finally{if($p){$p.Dispose()}}',
    '}',
    'foreach($p in $held){try{$p.Kill()}catch{}}',
    '$until=[DateTime]::UtcNow.AddSeconds(5)',
    '$left=@($held|Where-Object{try{-not $_.WaitForExit([int][Math]::Max(0,($until-[DateTime]::UtcNow).TotalMilliseconds))}catch{$true}}|ForEach-Object{$_.Id})',
    `$procs=@(${PROCESS_QUERY})`,
    '@{held=@($heldIds);left=@($left);processes=$procs}|ConvertTo-Json -Compress -Depth 4',
    '}finally{foreach($p in $held){try{$p.Dispose()}catch{}}}',
  ].join('; ');
  return runPowerShell(script, (stdout) => {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('processes' in parsed)) {
      throw new Error('Invalid Windows end result payload');
    }
    const processes = parseWindowsProcessRows(parsed.processes);
    if (processes.length === 0) throw new Error('Empty Windows process snapshot');
    return {
      held: parsePidArray(parsed.held),
      left: parsePidArray(parsed.left),
      processes,
    };
  }, false, run);
}
