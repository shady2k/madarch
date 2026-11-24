import { afterAll, expect } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { collectStartup, type StartupRecord } from './startup-trace-collector.js';
const source = join(import.meta.dir, '..', 'scripts', 'madarch.ts');
export const preload = join(import.meta.dir, 'fixtures', 'startup-boundary-preload.ts');
const root = mkdtempSync(join(tmpdir(), 'startup-boundaries-'));
chmodSync(root, 0o700);
afterAll(() => rmSync(root, { recursive: true, force: true }));
export function fixture(mode = 'direct') {
 const folder = mkdtempSync(join(root, 'case-')); const home = join(folder, 'products'); mkdirSync(home);
 const context = join(folder, 'context'); const collection = randomUUID(); const key = randomBytes(32).toString('hex');
 writeFileSync(context, JSON.stringify({ version: 1, collection, key }), { mode: 0o600 });
 const receipts = join(folder, 'receipts'); const config = join(folder, 'config');
 writeFileSync(config, JSON.stringify({ context, key, receipts, mode }), { mode: 0o600 });
 const app = join(folder, 'app'); mkdirSync(join(app, 'dist'), { recursive: true });
 writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'true' } }));
 writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html><title>Boundary fixture</title>');
 const bin = join(folder, 'bin'); mkdirSync(bin);
 const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
 writeFileSync(join(bin, 'bun'), `#!/bin/sh\nexec ${quote(process.execPath)} --preload ${quote(preload)} "$@"\n`, { mode: 0o700 });
 writeFileSync(join(bin, 'systemd-run'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, 'fixtures', 'startup-boundary-scope.ts'))} "$@"\n`, { mode: 0o700 });
 const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MADARCH_HOME: folder, MADARCH_APP: app, MADARCH_APP_DIST: join(app, 'dist'), MADARCH_OWN_WIKI: 'off', MADARCH_STARTUP_TIMING: '1', MADARCH_TRACE: 'on', MADARCH_STARTUP_CONTEXT: context, STARTUP_BOUNDARY_CONFIG: config };
 return { folder, home, context, collection, key, receipts, env };
}
export type Fixture = ReturnType<typeof fixture>;
export function launch(f: Fixture, args: string[], env = f.env) {
 const child = Bun.spawn([process.execPath, '--preload', preload, source, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
 const out = new Response(child.stdout).text(); let stderr = '';
 const err = (async () => { const decoder = new TextDecoder(); for await (const chunk of child.stderr) stderr += decoder.decode(chunk, { stream: true }); stderr += decoder.decode(); return stderr; })();
 return { child, snapshot: () => stderr, result: async () => ({ code: await child.exited, stdout: await out, stderr: await err }) };
}
export function observed(f: Fixture): any[] { return existsSync(f.receipts) ? readFileSync(f.receipts, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)) : []; }
export function ready(records: StartupRecord[], f: Fixture, roles: string[]) {
 for (const role of roles) expect(records.some(r => r.role === role), `missing real ${role} stream`).toBe(true);
 for (const r of records) expect(r).toMatchObject({ context: 'ready', collection: f.collection });
 expect(new Set(records.map(r => r.keyId)).size).toBe(1);
 expect(records.every(r => r.keyId !== undefined)).toBe(true);
}
export async function port(): Promise<number> {
 return await new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const a = server.address(); if (a === null || typeof a === 'string') throw new Error(`${import.meta.path}:1: missing port receipt`); server.close(() => resolve(a.port)); }); });
}
export async function until(work: () => boolean | Promise<boolean>, what: string) {
 const limit = Date.now() + 15_000;
 while (!(await work())) { if (Date.now() > limit) throw new Error(`${import.meta.path}:1: missing evidence: ${what}`); await Bun.sleep(20); }
}
export function clean(text: string) { return text.split('\n').filter(line => { try { return JSON.parse(line).version !== 1; } catch { return true; } }).join('\n'); }

/** Private controller evidence contains record metadata, never context paths or key material. */
export function saveBoundaryEvidence(name: string, text: string, appendOffset?: number): void {
 const destination = process.env.STARTUP_BOUNDARY_EVIDENCE;
 if (destination === undefined) return;
 const parsed = collectStartup(text);
 mkdirSync(destination, { recursive: true });
 writeFileSync(join(destination, `${name}.json`), JSON.stringify({ appendOffset, bytes: Buffer.byteLength(text), lines: text.split('\n').length - 1, startupWrites: parsed.records.length, incomplete: parsed.incomplete, records: parsed.records }, null, 2), { mode: 0o600 });
}
