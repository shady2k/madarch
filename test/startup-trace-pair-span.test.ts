import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createFixtureOwner, saveBoundaryEvidence } from './startup-boundary-fixture.js';
const fixture = createFixtureOwner();
test('startup pairs capture only their own open-run span once at begin', async () => {
 const f = fixture();
 const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/startup-correction-spans.ts'), f.home], { env: f.env, stdout: 'pipe', stderr: 'pipe' });
 const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
 expect(code, stderr).toBe(0); const records = JSON.parse(stdout.trim());
 for (const phase of ['fixture.foreign', 'fixture.cross']) {
  const pair = records.filter((r: any) => r.phase === phase); expect(pair).toHaveLength(2);
  for (const r of pair) { expect(r.spanId, `${phase} cannot borrow active span`).toBeUndefined(); expect(r.traceId).toBeUndefined(); }
 }
 const owned = records.filter((r: any) => r.phase === 'fixture.owned'); expect(owned).toHaveLength(2);
 expect(owned[0].spanId).toBeDefined(); expect(owned[1].spanId).toBe(owned[0].spanId); expect(owned[1].traceId).toBe(owned[0].traceId);
 saveBoundaryEvidence('pair-span', stderr);
});
