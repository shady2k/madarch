#!/usr/bin/env bun
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quarantineInventory } from './check-quarantine.js';

const PROCESS_TIMEOUT_MS = 900_000;
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cell = (text: string): string => text.replace(/\|/g, '&#124;').replace(/[\r\n]/g, ' ');
const results: string[] = ['## Quarantined tests', '', '| Task | File | Case | Reason | Since | Result |', '| --- | --- | --- | --- | --- | --- |'];
const recorded: Record<string, unknown>[] = [];
let failed = false;
const folder = mkdtempSync(join(tmpdir(), 'madarch-quarantine-'));
try {
  const cases = quarantineInventory();
  for (const [index, entry] of cases.entries()) {
    const report = join(folder, `${index}.xml`);
    let result: string;
    let timedOut = false;
    try {
      console.log(`\n${entry.task}: ${entry.file}: ${entry.name}`);
      const child = Bun.spawn([process.execPath, 'test', `./${entry.file}`, '--test-name-pattern', `^${escapeRegex(entry.name)}$`, '--reporter=junit', `--reporter-outfile=${report}`], {
        env: { ...process.env, MADARCH_QUARANTINE: '1' },
        stdout: 'inherit', stderr: 'inherit', detached: true,
      });
      // Kill the whole process group, including fixture daemons, if a hook hangs.
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }, PROCESS_TIMEOUT_MS);
      let code: number;
      try { code = await child.exited; } finally { clearTimeout(timer); }
      if (timedOut) result = 'FAIL (900s process timeout)';
      else if (code !== 0) result = `FAIL (process exit ${code}; test or hook failure)`;
      else {
        const xml = readFileSync(report, 'utf8');
        const executed = [...xml.matchAll(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g)].filter(match => !/<skipped\b/.test(match[0]));
        // Zero exit alone can mean the name did not match anything.
        result = executed.length === 1 && !/<(?:failure|error)\b/.test(xml) ? 'PASS' : 'FAIL (expected exactly one executed case in JUnit report)';
      }
    } catch (error) {
      result = `FAIL (${error instanceof Error ? error.message : String(error)})`;
    }
    recorded.push({ file: entry.file, name: entry.name, task: entry.task, since: entry.since,
      result: result === 'PASS' ? 'PASS' : 'FAIL', commit: process.env.GITHUB_SHA ?? null,
      ...(process.env.GITHUB_RUN_ID ? { runUrl: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` } : {}),
      finishedAt: new Date().toISOString() });
    failed ||= result !== 'PASS';
    console.log(`${result}: ${entry.name}`);
    results.push(`| ${cell(entry.task)} | ${cell(entry.file)} | ${cell(entry.name)} | ${cell(entry.reason)} | ${cell(entry.since)} | ${cell(result)} |`);
  }
  if (!cases.length) results.push('| — | — | No quarantined cases | — | — | — |');
} catch (error) {
  failed = true;
  results.push('', `Inventory failed: ${cell(error instanceof Error ? error.message : String(error))}`);
} finally {
  rmSync(folder, { recursive: true, force: true });
  if (process.env.MADARCH_QUARANTINE_REPORT) writeFileSync(process.env.MADARCH_QUARANTINE_REPORT, `${JSON.stringify({ cases: recorded }, null, 2)}\n`);
  const summary = `${results.join('\n')}\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
process.exitCode = failed ? 1 : 0;
