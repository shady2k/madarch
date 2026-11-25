import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectStartup } from './startup-trace-collector.js';
import { createFixtureOwner, launch, observed, preload, port, saveBoundaryEvidence, until } from './startup-boundary-fixture.js';
import { records } from './startup-lifecycle-fixture.js';
const fixture = createFixtureOwner();
for (const json of [false, true]) test(`S3 ${json ? 'JSON' : 'human'} address follows proof and is acknowledged by its actual pipe reader`, async () => {
 const f = fixture('address'); const p = await port();
 const child = Bun.spawn([process.execPath, '--preload', preload, join(import.meta.dir, '../scripts/madarch.ts'), 'init', join(f.folder, 'idea'), '--home', f.home, '--no-open', '--port', String(p), ...(json ? ['--json'] : [])], { env: { ...f.env, MADARCH_LANG: 'en', GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }, stdout: 'pipe', stderr: 'pipe' });
 let stderr = ''; let stdout = ''; let receipt = false;
 const err = (async () => { const decoder = new TextDecoder(); for await (const chunk of child.stderr) stderr += decoder.decode(chunk, { stream: true }); stderr += decoder.decode(); })();
 const out = (async () => { const decoder = new TextDecoder(); for await (const chunk of child.stdout) {
  stdout += decoder.decode(chunk, { stream: true });
  if (!receipt && /http:\/\/127\.0\.0\.1:\d+\/products\//.test(stdout)) {
   receipt = true;
   // Producer is blocked inside console.log until this reader acknowledges the pipe bytes.
   await until(() => observed(f).some(r => r.addressWritten), 'address writer barrier');
   await until(() => collectStartup(stderr).records.some(r => r.phase === 'daemon.proof' && r.edge === 'terminal' && r.outcome === 'ok'), 'stderr drained through verified proof while address writer is blocked');
   const parsed = collectStartup(stderr).records;
   expect(parsed.some(r => r.phase === 'daemon.proof' && r.edge === 'terminal' && r.outcome === 'ok'), 'proof must precede pipe address receipt').toBe(true);
   expect(parsed.some(r => r.phase === `address.write.${json ? 'json' : 'human'}` && r.edge === 'terminal'), 'writer completion cannot precede reader receipt at barrier').toBe(false);
   writeFileSync(f.receipts + '.pipe-ack', 'ack');
  }
 } stdout += decoder.decode(); })();
 try {
  const [code] = await Promise.all([child.exited, out, err]); expect(code, stdout + stderr).toBe(0); expect(receipt).toBe(true);
  const parsed = records(stderr); const proof = parsed.findLast(r => r.phase === 'daemon.proof' && r.edge === 'terminal' && r.outcome === 'ok')!;
  const address = parsed.filter(r => r.phase === `address.write.${json ? 'json' : 'human'}`);
  expect(proof.sequence, 'address mark must follow proof').toBeLessThan(address[0]!.sequence); expect(address).toHaveLength(2);
  expect(address[1]!.outcome).toBe('ok'); expect(observed(f).some(r => r.pipeReceiptReleased)).toBe(true);
  saveBoundaryEvidence(`lifecycle-address-${json ? 'json' : 'human'}`, stderr);
 } finally {
  writeFileSync(f.receipts + '.pipe-ack', 'ack');
  if (child.exitCode === null) { child.kill(); await child.exited; }
  await launch(f, ['stop', '--home', f.home]).result();
 }
}, 60_000);
