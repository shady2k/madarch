import { expect } from 'bun:test';
import { join } from 'node:path';
import { collectStartup } from './startup-trace-collector.js';
import { preload, type Fixture } from './startup-boundary-fixture.js';
export function records(stderr: string) {
 const parsed = collectStartup(stderr); expect(parsed.incomplete).toEqual([]); return parsed.records;
}
export async function fixtureRun(f: Fixture, mode: string) {
 const child = Bun.spawn([process.execPath, '--preload', preload, join(import.meta.dir, 'fixtures/startup-lifecycle.ts'), f.home, mode], { env: f.env, stdout: 'pipe', stderr: 'pipe' });
 const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
 expect(code, stdout + stderr).toBe(0);
 return { stdout, stderr, facts: JSON.parse(stdout.trim().split('\n').at(-1)!), records: records(stderr) };
}
