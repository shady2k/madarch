#!/usr/bin/env bun
/** Explicit operator acceptance only. Importing this module never starts services.
 * The held training product is an oracle here, never a production special case.
 * Run --probe-only first; a separate --walk consumes that result on the SAME pod.
 * No probe failure installs tools, changes privileges, or substitutes a service.
 */
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { GuideContext, GuideDocument, GuideReceipt } from '../src/writer/guides/model.js';
import { GUIDE_RECEIPT_SCHEMA } from '../src/writer/guides/model.js';
import { guideDigest, guideStepDigest } from '../src/writer/guides/digest.js';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CAPABILITY_PROBE = `set +e
command -v docker; docker_cli=$?
command -v make; make_cli=$?
command -v node; node_cli=$?
command -v git; git_cli=$?
command -v timeout; timeout_cli=$?
timeout 15s docker info --format 'server={{.ServerVersion}} driver={{.Driver}} os={{.OSType}}'; daemon=$?
timeout 10s docker compose version; compose=$?
printf 'CAPABILITY docker=%s make=%s node=%s git=%s timeout=%s daemon=%s compose=%s\n' "$docker_cli" "$make_cli" "$node_cli" "$git_cli" "$timeout_cli" "$daemon" "$compose"
test "$docker_cli" -eq 0 && test "$make_cli" -eq 0 && test "$node_cli" -eq 0 && test "$git_cli" -eq 0 && test "$timeout_cli" -eq 0 && test "$daemon" -eq 0 && test "$compose" -eq 0`;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const activeChildren = new Set<() => void>();
const OUTPUT_BOUND = 4 * 1024 * 1024;
const TOTAL_MS = 40 * 60_000;
const PORTS = [5432, 9092, 9094, 8080, 8081, 8082, 8083, 50051];
export interface CommandResult { status: number; stdout: string; stderr: string; timedOut: boolean; overflow: boolean }
export interface WalkInvocation { kind: 'command' | 'http'; content: string; cwd: string; environment: string;
  physicalCwd?: string; repository?: string; commit?: string; deployment?: string; instructionDigest?: string }
export interface WalkEvidence {
  schema: 'madarch.operator-guide-evidence@1';
  run: string; sequence: number; action: string; invocation: WalkInvocation;
  startedAt: string; finishedAt: string; actualStatus: number; observed: string;
  expectedStatus: number; checks: readonly { name: string; passed: boolean }[];
  passed: boolean; evidence: string; digest: string;
  guideBinding?: { product: string; guide: string; procedure: string; step: string; commandDigest: string; prerequisitesDigest: string; expectedDigest: string; oracle: GuideOracle };
}
interface Manifest {
  schema: 'madarch.operator-guide-walk@1'; run: string; host: string; engine: string;
  sourceDigest: string;
  fixture: string; project: string; guideState?: 'not-walked' | 'captured-pending-operator-import'; state: 'capability-passed' | 'blocked' | 'running' | 'passed' | 'failed';
  trust: 'untrusted-pending-operator-import';
  createdAt: string; finishedAt?: string; events: WalkEvidence[]; failure?: string;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
/** Literal values come from actual isolated configuration/tokens, not text patterns.
 * Unknown unstructured process output is withheld by record(), not "secret scanned".
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let safe = text;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) safe = safe.split(secret).join('[REDACTED]');
  return safe;
}
export function redactStructured(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    try { const url = new URL(value); if (url.password) url.password = '[REDACTED]'; if (url.username) url.username = '[REDACTED]'; return redact(url.toString(), secrets); }
    catch { return redact(value, secrets); }
  }
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, secrets));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStructured(item, secrets)]));
  return value;
}
/** Detects accidental capture changes only. A local digest is NOT execution authority. */
export function matchesCapturedEvidence(event: WalkEvidence, actual: string, invocation: WalkInvocation): boolean {
  return event.schema === 'madarch.operator-guide-evidence@1' && event.digest === digest({ ...event, digest: undefined })
    && canonical(event.invocation) === canonical(invocation) && actual === event.observed
    && Number.isInteger(event.actualStatus) && Number.isFinite(Date.parse(event.startedAt))
    && Number.isFinite(Date.parse(event.finishedAt)) && Date.parse(event.finishedAt) >= Date.parse(event.startedAt);
}
export function assertStatus(actual: number, expected: number, checks: readonly { name: string; passed: boolean }[]): boolean {
  return actual === expected && checks.every((check) => check.passed);
}
export function safeOutputRoot(checkout: string, output: string): string {
  const path = resolve(output); const rel = relative(resolve(checkout), path);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) throw new Error(`${path}:1: $: operator output must be outside the checkout`);
  return path;
}
/** All child processes are bounded as a group. Overflow fails; it is never a smaller success. */
export async function command(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv, milliseconds: number,
  input?: string): Promise<CommandResult> {
  const executable = argv[0]; if (!executable) throw new Error('empty command');
  return await new Promise((answer) => {
    const child = spawn(executable, argv.slice(1), { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, timedOut = false, overflow = false, settled = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = (): void => {
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* already stopped */ }
      force ??= setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* stopped */ } }, 1_000);
    };
    activeChildren.add(kill);
    const timer = setTimeout(() => { timedOut = true; kill(); }, milliseconds);
    const append = (chunk: Buffer, target: 'stdout' | 'stderr'): void => {
      bytes += chunk.length;
      if (bytes > OUTPUT_BOUND) { overflow = true; kill(); return; }
      if (target === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
    const finish = (status: number): void => {
      if (settled) return; settled = true; activeChildren.delete(kill); clearTimeout(timer); // A pending escalation must remain live until the whole group is killed.
      answer({ status: overflow ? 125 : timedOut ? 124 : status, stdout, stderr, timedOut, overflow });
    };
    child.on('error', () => { stderr += 'executable unavailable'; finish(127); });
    child.on('close', (status, signal) => finish(status ?? (signal ? 128 : 1)));
    child.stdin.on('error', () => { /* early process failure is recorded by close */ });
    child.stdin.end(input);
  });
}

class Operator {
  readonly secrets = ['local-development-secret'];
  readonly inputs: Record<string, string> = {};
  interrupted = false;
  readonly deadline = Date.now() + TOTAL_MS;
  readonly fixture: string;
  readonly env: NodeJS.ProcessEnv;
  constructor(readonly out: string, readonly manifest: Manifest) {
    this.fixture = join(out, 'repository');
    // Do not inherit an owner's database, JWT, provider or remote Docker overrides.
    this.env = { PATH: process.env.PATH, HOME: out, TMPDIR: process.env.TMPDIR,
      LANG: 'C.UTF-8', DOCKER_CONFIG: join(out, 'docker'), COMPOSE_PROJECT_NAME: manifest.project,
      HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY };
    for (const proxy of [this.env.HTTP_PROXY, this.env.HTTPS_PROXY]) if (proxy) this.secrets.push(proxy);
  }
  async save(): Promise<void> { await writeFile(join(this.out, 'operator-manifest.json'), `${JSON.stringify(redactStructured(this.manifest, this.secrets), null, 2)}\n`, { mode: 0o600 }); }
  async record(action: string, invocation: WalkInvocation, start: string, status: number, expected: number,
    observed: string, checks: readonly { name: string; passed: boolean }[] = [], output: 'withheld' | 'structured' | 'known' = 'known', guideBinding?: WalkEvidence['guideBinding']): Promise<WalkEvidence> {
    let safe = '[unstructured/sensitive output withheld; actual status and typed checks retained]';
    if (output === 'known') safe = redact(observed, this.secrets);
    if (output === 'structured') { try { safe = JSON.stringify(redactStructured(JSON.parse(observed), this.secrets)); } catch { /* withhold unknown text */ } }
    invocation = { ...invocation, content: redact(invocation.content, this.secrets), instructionDigest: invocation.instructionDigest ?? digest(invocation.content) };
    invocation = redactStructured(invocation, this.secrets) as WalkInvocation;
    checks = redactStructured(checks, this.secrets) as typeof checks;
    const sequence = this.manifest.events.length + 1;
    const evidence = `evidence/${String(sequence).padStart(3, '0')}.txt`;
    action = redact(action, this.secrets);
    const fields = { schema: 'madarch.operator-guide-evidence@1' as const, run: this.manifest.run, sequence, action,
      invocation, startedAt: start, finishedAt: new Date().toISOString(), actualStatus: status, expectedStatus: expected,
      observed: safe, checks, passed: assertStatus(status, expected, checks), evidence, ...(guideBinding ? { guideBinding } : {}) };
    const event: WalkEvidence = { ...fields, digest: digest({ ...fields, digest: undefined }) };
    await writeFile(join(this.out, evidence), safe, { flag: 'wx', mode: 0o600 });
    this.manifest.events.push(event); await this.save(); return event;
  }
  budget(milliseconds: number, cleanup = false): number {
    if (this.interrupted && !cleanup) throw new Error('operator interrupted the walk');
    const remaining = this.deadline - Date.now() - (cleanup ? 0 : 130_000);
    if (remaining <= 0) throw new Error('overall walk deadline exhausted');
    return Math.min(milliseconds, remaining);
  }
  async run(action: string, argv: readonly string[], timeout = 30_000, options: { cwd?: string; input?: string; sensitive?: boolean; cleanup?: boolean } = {}): Promise<CommandResult> {
    const cwd = options.cwd ?? this.fixture;
    const invocation: WalkInvocation = { kind: 'command', content: argv.map((v) => JSON.stringify(v)).join(' '), cwd, environment: this.manifest.project };
    const started = new Date().toISOString();
    const result = await command(argv, cwd, this.env, this.budget(timeout, options.cleanup), options.input);
    const event = await this.record(action, invocation, started, result.status, 0, `${result.stdout}${result.stderr}`, [
      { name: 'within-output-bound', passed: !result.overflow }, { name: 'within-time-bound', passed: !result.timedOut },
    ], options.sensitive ? 'withheld' : ['make-up', 'make-seed', 'bounded-runtime-logs', 'make-down', 'project-volume-cleanup', 'generate-fixture', 'runtime-images'].includes(action) ? 'withheld' : 'known');
    if (!event.passed) throw new Error(`${join(this.out, event.evidence)}:1: $.${action}: command own exit ${result.status}`);
    return result;
  }
  async request(action: string, port: number, path: string, expected: number, token?: string, body?: unknown,
    checks: (value: Record<string, unknown>, text: string) => readonly { name: string; passed: boolean }[] = () => [], key?: string): Promise<Record<string, unknown>> {
    const url = `http://127.0.0.1:${port}${path}`;
    const method = body === undefined ? 'GET' : 'POST';
    const invocation: WalkInvocation = { kind: 'http', content: `${method} ${url}${body === undefined ? '' : `\n${redact(JSON.stringify(body), this.secrets)}`}`, cwd: this.fixture, environment: this.manifest.project };
    const started = new Date().toISOString();
    let status = 0, text = '', parsed: Record<string, unknown> = {}, assertions: readonly { name: string; passed: boolean }[] = [];
    try {
      const response = await fetch(url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(this.budget(10_000)) });
      status = response.status;
      // Enforce the evidence bound while reading; never accept an unseen tail.
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let count = 0;
      if (reader) for (;;) { const next = await reader.read(); if (next.done) break; count += next.value.length;
        if (count > OUTPUT_BOUND) { await reader.cancel(); throw new Error('HTTP evidence exceeds bound'); } chunks.push(next.value); }
      text = Buffer.concat(chunks).toString();
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* CSV/text have their own assertions */ }
      assertions = checks(parsed, text);
    } catch { status = 0; text = 'request unavailable, timed out, redirected or exceeded evidence bound'; }
    const event = await this.record(action, invocation, started, status, expected, text, assertions, path === '/orders/export' ? 'known' : 'structured');
    if (!event.passed) throw new Error(`${join(this.out, event.evidence)}:1: $.${action}: HTTP status/check mismatch (${status}, expected ${expected})`);
    return parsed;
  }
  async sql(action: string, database: 'orders' | 'payments', query: string, expected: string): Promise<void> {
    const argv = ['docker', 'compose', 'exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'training', '-d', database, '-At', '-c', query];
    const start = new Date().toISOString();
    const result = await command(argv, this.fixture, this.env, this.budget(15_000));
    const invocation: WalkInvocation = { kind: 'command', content: argv.map((v) => JSON.stringify(v)).join(' '), cwd: this.fixture, environment: this.manifest.project };
    const event = await this.record(action, invocation, start, result.status, 0, `${result.stdout}${result.stderr}`,
      [{ name: 'independent-database-state', passed: result.stdout.trim() === expected && !result.overflow && !result.timedOut }]);
    if (!event.passed) throw new Error(`${join(this.out, event.evidence)}:1: $.${action}: independent database mismatch`);
  }
  async waitReady(): Promise<void> {
    const until = Date.now() + this.budget(180_000);
    while (Date.now() < until) {
      const ready = await Promise.all([8080, 8081, 8082, 8083].map(async (port) => {
        try { const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) });
          return response.status === 200 && (await response.text()).includes('"ok"'); } catch { return false; }
      }));
      if (ready.every(Boolean)) {
        for (const port of [8080, 8081, 8082, 8083]) await this.request(`health-${port}`, port, '/healthz', 200, undefined, undefined, (v) => [{ name: 'health-ok', passed: v['status'] === 'ok' }]);
        await this.run('kafka-ready', ['docker', 'compose', 'exec', '-T', 'kafka', '/opt/kafka/bin/kafka-topics.sh', '--bootstrap-server', 'kafka:9092', '--list']);
        return;
      }
      await new Promise((done) => setTimeout(done, 500));
    }
    throw new Error('real service readiness deadline exceeded');
  }
  async waitOrder(id: string, expected: string, token: string): Promise<void> {
    const until = Date.now() + this.budget(45_000);
    while (Date.now() < until) {
      try { const response = await fetch(`http://127.0.0.1:8080/orders/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2_000) });
        const value = await response.json() as Record<string, unknown>;
        if (response.status === 200 && value['status'] === expected) {
          await this.request(`observe-order-${expected}`, 8080, `/orders/${id}`, 200, token, undefined, (v) => [{ name: 'eventual-state', passed: v['status'] === expected }]);
          await this.sql(`database-order-${expected}`, 'orders', `SELECT status FROM orders WHERE id='${id}';`, expected); return;
        }
      } catch { /* bounded eventual consistency; final absence is failure */ }
      await new Promise((done) => setTimeout(done, 500));
    }
    throw new Error(`order did not reach ${expected} through actual payment/consumer path`);
  }
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new Error('actual service returned invalid UUID');
  return value;
}
async function requireFreePort(port: number): Promise<void> {
  await new Promise<void>((done, fail) => {
    const server = createServer(); server.once('error', () => fail(new Error(`127.0.0.1:${port}:1: $: fixture port occupied; no service was stopped`)));
    server.listen(port, '0.0.0.0', () => server.close((error) => error ? fail(error) : done()));
  });
}

export interface SourceManifest { revision: string; files: readonly { path: string; sha256: string }[] }
/** Parent supplies the known revision plus byte digests, since staging excludes .git.
 * This checks staged bytes, NOT a self-certified revision or operator authority.
 */
export async function checkSourceManifest(file: string, root = ROOT): Promise<{ revision: string; sourceDigest: string }> {
  const manifest = JSON.parse(await readFile(file, 'utf8')) as SourceManifest;
  if (!manifest.revision || manifest.revision.length !== 40 || [...manifest.revision].some((char) => !'0123456789abcdef'.includes(char)) || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error(`${file}:1: $: explicit engine revision and source files required`);
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (!entry.path || isAbsolute(entry.path) || entry.path.split('/').includes('..') || seen.has(entry.path)) throw new Error(`${file}:1: $.files: unsafe/duplicate source path`);
    seen.add(entry.path);
    const path = resolve(root, entry.path);
    if (await realpath(path) !== path || createHash('sha256').update(await readFile(path)).digest('hex') !== entry.sha256) throw new Error(`${path}:1: $: staged source differs from explicit manifest`);
  }
  const templatePaths = async (folder: string): Promise<string[]> => {
    const entries = await readdir(resolve(root, folder), { withFileTypes: true }); const files: string[] = [];
    for (const entry of entries) { const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) files.push(...await templatePaths(path)); else if (entry.isFile()) files.push(path); else throw new Error(`${path}:1: $: non-regular fixture source`); }
    return files;
  };
  for (const path of await templatePaths('examples/training-repository/template')) if (!seen.has(path)) throw new Error(`${file}:1: $.files: omitted fixture source ${path}`);
  for (const required of ['scripts/guide-walk.ts', 'src/writer/guides/model.ts', 'src/writer/guides/digest.ts', 'src/model/order.ts', 'examples/training-repository/generate.mjs', 'examples/training-repository/history.mjs']) if (!seen.has(required)) throw new Error(`${file}:1: $.files: missing source ${required}`);
  return { revision: manifest.revision, sourceDigest: digest(manifest) };
}
export async function probe(out: string, sourceFile: string): Promise<Manifest> {
  out = safeOutputRoot(ROOT, out);
  const source = await checkSourceManifest(sourceFile);
  await mkdir(out, { mode: 0o700 }); // Existing path is refused, never erased.
  if (await realpath(out) !== out) throw new Error(`${out}:1: $: operator root must not traverse a symlink`);
  await mkdir(join(out, 'evidence'), { mode: 0o700 }); await mkdir(join(out, 'docker'), { mode: 0o700 });
  const manifest: Manifest = { schema: 'madarch.operator-guide-walk@1', run: randomUUID(), host: hostname(), engine: source.revision, sourceDigest: source.sourceDigest,
    fixture: '', project: `guidewalk-${randomUUID().replaceAll('-', '')}`, state: 'blocked', createdAt: new Date().toISOString(), events: [], trust: 'untrusted-pending-operator-import' };
  const operator = new Operator(out, manifest); await operator.save();
  try {
    await operator.run('capability', ['timeout', '45s', 'bash', '-c', CAPABILITY_PROBE], 46_000, { cwd: ROOT });
    manifest.state = 'capability-passed';
  } catch (error) { manifest.failure = redact(String(error), operator.secrets); }
  await operator.save(); return manifest;
}
export async function walk(out: string, sourceFile: string, guidePlan?: string): Promise<Manifest> {
  out = safeOutputRoot(ROOT, out);
  const actual = await realpath(out); if (actual !== out || !(await stat(out)).isDirectory()) throw new Error(`${out}:1: $: output root must be a real directory`);
  const manifest = JSON.parse(await readFile(join(out, 'operator-manifest.json'), 'utf8')) as Manifest;
  if (manifest.schema !== 'madarch.operator-guide-walk@1' || manifest.state !== 'capability-passed' || manifest.host !== hostname()
    || !Number.isFinite(Date.parse(manifest.createdAt)) || Date.parse(manifest.createdAt) > Date.now()
    || Date.now() - Date.parse(manifest.createdAt) > 30 * 60_000 || !/^guidewalk-[a-f0-9]{32}$/.test(manifest.project)
    || !Array.isArray(manifest.events) || !manifest.events.some((e) => e.action === 'capability' && e.passed)) throw new Error(`${out}:1: $: successful fresh same-pod probe required`);
  if (typeof manifest.run !== 'string' || manifest.run.length !== 36 || manifest.run.split('-').map((part) => part.length).join(',') !== '8,4,4,4,12' || manifest.run.includes('/') || manifest.run.includes('\\')) throw new Error(`${out}:1: $: invalid operator run identity`);
  const operator = new Operator(out, manifest); manifest.state = 'running'; await operator.save();
  let started = false;
  const interrupt = (): void => { operator.interrupted = true; for (const stop of activeChildren) stop(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    for (const event of manifest.events) {
      if (!/^evidence\/[0-9]{3}\.txt$/.test(event.evidence)) throw new Error('unsafe operator evidence path');
      const path = join(out, event.evidence);
      if (await realpath(path) !== path || !matchesCapturedEvidence(event, await readFile(path, 'utf8'), event.invocation)) throw new Error('operator evidence was changed');
    }
    const source = await checkSourceManifest(sourceFile);
    if (source.revision !== manifest.engine || source.sourceDigest !== manifest.sourceDigest) throw new Error('staged source changed since probe');
    for (const port of PORTS) await requireFreePort(port);
    await operator.run('generate-fixture', ['node', join(ROOT, 'examples/training-repository/generate.mjs'), operator.fixture], 120_000, { cwd: ROOT });
    const fixtureRevision = await operator.run('fixture-revision', ['git', 'rev-parse', 'HEAD']); manifest.fixture = fixtureRevision.stdout.trim(); await operator.save();
    await operator.run('copy-development-env', ['cp', '.env.example', '.env']);
    // The source's documented development config, not owner credentials.
    const config = await readFile(join(operator.fixture, '.env'), 'utf8');
    for (const line of config.split('\n')) {
      const separator = line.indexOf('='); if (separator < 1 || line.startsWith('#')) continue;
      const name = line.slice(0, separator); const value = line.slice(separator + 1);
      if (name === 'JWT_SECRET' || name === 'DATABASE_URL') operator.secrets.push(value);
      // The source's published low-entropy database password is handled only in structured URLs, not used as a blanket substring mask.

    }
    // Cleanup is armed before ANY admitted startup instruction can run.
    started = true;
    manifest.guideState = 'not-walked';
    if (guidePlan) {
      await walkAdmittedGuides(operator, guidePlan);
      manifest.guideState = 'captured-pending-operator-import';
    } else {
      await operator.run('make-up', ['make', 'up'], 20 * 60_000);
      await operator.waitReady();
      await operator.run('make-seed', ['make', 'seed'], 120_000);
      await operator.sql('seed-customer', 'orders', "SELECT count(*) FROM customers WHERE id='demo';", '1');
      const shopper = (await operator.run('shopper-token', ['make', '-s', 'token'], 10_000, { sensitive: true })).stdout.trim();
      if (!/^[^.]+\.[^.]+\.[^.]+$/.test(shopper)) throw new Error('source token script did not print a token');
      operator.secrets.push(shopper); operator.inputs['SHOPPER_TOKEN'] = shopper;
      const support = (await operator.run('support-token', ['docker', 'compose', 'exec', '-T', 'payments', 'node', '-', 'demo', 'support'], 10_000,
        { input: await readFile(join(operator.fixture, 'scripts/token.mjs'), 'utf8'), sensitive: true })).stdout.trim();
      operator.secrets.push(support); operator.inputs['SUPPORT_TOKEN'] = support;
      const items = [{ sku: 'A-1', quantity: 2, priceCents: 1000 }];
      const key = `uc1-${manifest.run}`; operator.inputs['IDEMPOTENCY_KEY'] = key;
      const amounts = (v: Record<string, unknown>) => [{ name: 'source-derived-uc1-amounts', passed: v['customerId'] === 'demo'
        && v['status'] === 'pending_payment' && v['subtotalCents'] === 2000 && v['discountCents'] === 0 && v['taxCents'] === 160 && v['totalCents'] === 2160 }];
      const order = await operator.request('uc1-place', 8080, '/orders', 201, shopper, { items, discountPercent: 0 }, amounts, key);
      const id = identifier(order['id']); operator.inputs['ORDER_ID'] = id;
      const replay = await operator.request('uc1-replay', 8080, '/orders', 201, shopper, { items, discountPercent: 0 },
        (v) => [...amounts(v), { name: 'same-order-id', passed: v['id'] === id }], key);
      identifier(replay['id']);
      await operator.sql('uc1-idempotency-database', 'orders', `SELECT count(*) FROM orders WHERE request_id='${key}' AND customer_id='demo';`, '1');
      await operator.sql('uc1-line-database', 'orders', `SELECT sku || '|' || quantity || '|' || price_cents FROM order_items WHERE order_id='${id}';`, 'A-1|2|1000');
      await operator.waitOrder(id, 'pending_payment', shopper);
      await operator.request('missing-auth', 8080, `/orders/${id}`, 401);
      await operator.request('invalid-items', 8080, '/orders', 422, shopper, { items: [{ sku: 'A-1', quantity: 0, priceCents: 1000 }] });
      await operator.request('shopper-cannot-ship', 8080, `/orders/${id}/ship`, 403, shopper, {});
      await operator.request('pending-cannot-ship', 8080, `/orders/${id}/ship`, 409, support, {});
      await operator.request('support-lookup', 8080, `/orders/${id}`, 200, support);
      await operator.request('support-cancel', 8080, `/orders/${id}/cancel`, 200, support, { reason: 'isolated operator acceptance' }, (v) => [{ name: 'cancelled', passed: v['status'] === 'cancelled' }]);
      await operator.waitOrder(id, 'cancelled', shopper);
      const cardToken = `isolated-vault-${manifest.run}`; operator.secrets.push(cardToken); operator.inputs['CARD_TOKEN'] = cardToken;
      const paid = await operator.request('paid-checkout', 8083, '/checkout', 201, shopper, { items, cardToken, currency: 'EUR' },
        (v) => [{ name: 'payment-id-returned', passed: typeof v['paymentId'] === 'string' }], `paid-${manifest.run}`);
      const paidOrder = identifier((paid['order'] as Record<string, unknown>)?.['id']); const payment = identifier(paid['paymentId']); operator.inputs['PAID_ORDER_ID'] = paidOrder; operator.inputs['PAYMENT_ID'] = payment;
      await operator.waitOrder(paidOrder, 'confirmed', shopper); // Real Kafka consumer, not health alone.
      await operator.sql('captured-payment', 'payments', `SELECT status || '|' || amount_cents FROM payments WHERE id='${payment}' AND order_id='${paidOrder}';`, 'captured|2160');
      await operator.request('support-ship', 8080, `/orders/${paidOrder}/ship`, 200, support, {}, (v) => [{ name: 'shipped', passed: v['status'] === 'shipped' }]);
      await operator.waitOrder(paidOrder, 'shipped', shopper);
      // A zero amount reaches BaseProvider's genuine rejection, NOT a bank/issuer decline.
      const declined = await operator.request('zero-amount-provider-rejection', 8083, '/checkout', 402, shopper,
        { items: [{ sku: 'ZERO', quantity: 1, priceCents: 0 }], cardToken, currency: 'EUR' },
        (v) => [{ name: 'actual-provider-rejection', passed: v['error'] === 'payment_declined' && v['reason'] === 'amount must be positive' }], `zero-${manifest.run}`);
      const declinedOrder = identifier(declined['orderId']); await operator.waitOrder(declinedOrder, 'cancelled', shopper);
      await operator.sql('declined-payment', 'payments', `SELECT status || '|' || amount_cents FROM payments WHERE order_id='${declinedOrder}';`, 'declined|0');
      await operator.request('full-refund', 8081, `/payments/${payment}/refunds`, 201, support, { amountCents: 2160, reason: 'isolated acceptance' });
      await operator.sql('refund-database', 'payments', `SELECT COALESCE(sum(amount_cents),0) FROM refunds WHERE payment_id='${payment}';`, '2160');
      await operator.waitOrder(paidOrder, 'refunded', shopper);
      await operator.request('unauthenticated-export-warning', 8080, '/orders/export', 200, undefined, undefined,
        (_, text) => [{ name: 'actual-unprotected-export-csv', passed: text.startsWith('id,customer_id,status,total_cents,created_at') && text.includes(id) }]);
      for (const report of ['daily-settlement', 'reconciliation']) await operator.request(`finance-${report}`, 8081,
        `/reports/legacy?report=${report}&format=json`, 200, support, undefined,
        (v) => [{ name: 'existing-report-not-complete-settlement-workflow', passed: v['report'] === report && Array.isArray(v['rows']) }]);
    }
    await operator.run('runtime-images', ['docker', 'compose', 'images', '--format', 'json']);
    manifest.state = 'passed';
  } catch (error) { manifest.state = 'failed'; manifest.failure = redact(String(error), operator.secrets); }
  finally {
    if (started) {
      try { await operator.run('bounded-runtime-logs', ['docker', 'compose', 'logs', '--no-color', '--tail', '100'], 15_000, { cleanup: true }); }
      catch (error) { manifest.state = 'failed'; manifest.failure = [manifest.failure, redact(String(error), operator.secrets)].filter(Boolean).join('; '); }
      try { await operator.run('make-down', ['make', 'down'], 90_000, { cleanup: true }); }
      catch (error) { manifest.state = 'failed'; manifest.failure = [manifest.failure, redact(String(error), operator.secrets)].filter(Boolean).join('; '); }
      // Even failed source down cannot skip cleanup of ONLY this isolated project.
      try { await operator.run('project-volume-cleanup', ['docker', 'compose', 'down', '--volumes', '--remove-orphans'], 30_000, { cleanup: true }); }
      catch (error) { manifest.state = 'failed'; manifest.failure = [manifest.failure, redact(String(error), operator.secrets)].filter(Boolean).join('; '); }
    }
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    manifest.finishedAt = new Date().toISOString(); await operator.save();
  }
  return manifest;
}

/** Explicit operator data, never emitted by the guide-writing agent. The host
 * still must admit exported evidence independently; this file is not authority.
 * Each typed oracle is bound to the exact expected-result digest. No English
 * sentence matching, substring pass, or successful action relabelling occurs.
 */
export type GuideOracle =
  | { kind: 'json-fields'; fields: Readonly<Record<string, unknown>> }
  | { kind: 'sql-equals'; database: 'orders' | 'payments'; query: string; value: string }
  | { kind: 'services-ready' }
  | { kind: 'csv-header'; columns: readonly string[] }
  | { kind: 'issued-token'; secretInput: string };
export interface NativeAdmission { procedure: string; step: string; commandDigest: string; expectedDigest: string; action: string; oracle: GuideOracle; timeoutMs?: number;
  capture?: readonly { input: string; path: readonly string[] }[] }
export interface NativeGuidePlan { product: string; repository: string; commit: string; environment: string; guideFile: string; inputs?: Readonly<Record<string, string>>; admissions: readonly NativeAdmission[] }
export function compareJsonFields(actual: unknown, expected: Readonly<Record<string, unknown>>): boolean {
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual) || Object.keys(expected).length === 0) return false;
  const object = actual as Record<string, unknown>;
  return Object.entries(expected).every(([key, value]) => canonical(object[key]) === canonical(value));
}
export function resolveGuideCwd(fixture: string, repository: string, cwd: string): string {
  const parts = cwd.split('/');
  if (parts[0] !== 'repos' || parts[1] !== repository || parts.includes('..') || parts.includes('') || isAbsolute(cwd)) throw new Error('guide cwd must be the admitted repository-relative directory');
  return resolve(fixture, ...parts.slice(2));
}
/** Full native acceptance is exactly administrator then user in one fresh deployment. */
export function requireGuidePair(kinds: readonly string[]): void {
  if (kinds.length !== 2 || kinds[0] !== 'administrator-guide' || kinds[1] !== 'user-guide') throw new Error('full native walk requires exactly one administrator guide then one user guide; single/reversed/duplicate plans are partial, not walked');
}
async function walkAdmittedGuides(operator: Operator, file: string): Promise<void> {
  const plans = JSON.parse(await readFile(file, 'utf8')) as NativeGuidePlan[];
  if (!Array.isArray(plans) || plans.length === 0 || plans.length > 4) throw new Error(`${file}:1: $: expected one to four explicitly admitted guides`);
  await mkdir(join(operator.out, 'evidence', operator.manifest.run), { mode: 0o700 });
  const loaded = await Promise.all(plans.map(async (plan) => ({ plan, guide: JSON.parse(await readFile(plan.guideFile, 'utf8')) as GuideDocument })));
  requireGuidePair(loaded.map(({ guide }) => guide.kind));
  const receipts: GuideReceipt[] = [];
  for (const { plan, guide } of loaded) {
    if (!plan.product || plan.commit !== operator.manifest.fixture || !guide.context.repositories.some((repo) => repo.name === plan.repository && repo.commit === plan.commit)) throw new Error(`${file}:1: $: guide repository must match actual generated revision`);
    if (!Array.isArray(plan.admissions) || plan.admissions.length === 0 || plan.admissions.length > 400) throw new Error(`${file}:1: $: bounded explicit native admissions required`);
    for (const [name, value] of Object.entries(plan.inputs ?? {})) {
      if (typeof value !== 'string' || !name || operator.inputs[name] !== undefined) throw new Error(`${file}:1: $: invalid/duplicate explicit operator input ${name}`);
      operator.inputs[name] = value;
      if (guide.procedures.some((procedure) => procedure.steps.some((step) => step.inputs.some((input) => input.name === name && input.secret)))) operator.secrets.push(value);
    }
    const admitted = new Set<string>();
    for (const admission of plan.admissions) {
      const procedure = guide.procedures.find((value) => value.id === admission.procedure);
      const step = procedure?.steps.find((value) => value.id === admission.step);
      const identity = `${admission.procedure}/${admission.step}`;
      if (!procedure || !step || admitted.has(identity) || admission.commandDigest !== guideStepDigest(guide, procedure.id, step)
        || admission.expectedDigest !== guideDigest(step.expected)) throw new Error(`${file}:1: $: missing/stale/duplicate explicit step admission`);
      admitted.add(identity);
      const physicalCwd = resolveGuideCwd(operator.fixture, plan.repository, step.cwd);
      if (await realpath(physicalCwd) !== physicalCwd) throw new Error(`${physicalCwd}:1: $: guide cwd traverses a symlink`);
      if (!plan.environment || step.environment !== plan.environment) throw new Error(`${file}:1: $: guide environment differs from explicit operator deployment mapping`);
      const invocation: WalkInvocation = { kind: step.instruction.kind, content: step.instruction.content,
        instructionDigest: digest(step.instruction.content), cwd: step.cwd, physicalCwd, environment: step.environment, deployment: operator.manifest.project,
        repository: plan.repository, commit: plan.commit };
      const nativeEnv = { ...operator.env };
      for (const input of step.inputs) { const value = operator.inputs[input.name];
        if (value === undefined) throw new Error(`${file}:1: $: missing actual isolated input ${input.name}`);
        nativeEnv[input.name] = value;
      }
      const timeoutMs = admission.timeoutMs ?? 120_000;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20 * 60_000) throw new Error(`${file}:1: $: native command timeout must be bounded at 1200000ms`);
      const replaceInputs = (value: string): string => { let result = value;
        for (const [name, input] of Object.entries(operator.inputs)) result = result.split('${' + name + '}').join(input);
        return result; };
      const start = new Date().toISOString(); let actualStatus = 0, observed = '', rawOutput = '';
      let parsed: unknown;
      if (step.instruction.kind === 'command') {
        // The exact admitted instruction is executed, not a different argv oracle.
        const result = await command(['bash', '-e', '-o', 'pipefail', '-c', step.instruction.content], physicalCwd, nativeEnv, operator.budget(timeoutMs));
        actualStatus = result.status; rawOutput = result.stdout;
        observed = JSON.stringify({ ownExit: result.status, timedOut: result.timedOut, overflow: result.overflow });
        if (result.timedOut || result.overflow) actualStatus = result.overflow ? 125 : 124;
      } else {
        // HTTP instructions use a structured request, not regex-parsed curl/prose.
        const request = JSON.parse(step.instruction.content) as { method: string; url: string; headers?: Record<string, string>; body?: unknown };
        const url = new URL(replaceInputs(request.url));
        if (!['http:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || ![8080, 8081, 8082, 8083].includes(Number(url.port)) || url.username || url.password
          || !['GET', 'POST'].includes(request.method)) throw new Error(`${file}:1: $: native HTTP must target the real isolated service`);
        const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([key, value]) => [key, replaceInputs(value)]));
        const body = request.body === undefined ? undefined : JSON.parse(replaceInputs(JSON.stringify(request.body))) as unknown;
        try {
          const response = await fetch(url, { method: request.method, headers,
            body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(operator.budget(10_000)) });
          actualStatus = response.status;
          const length = Number(response.headers.get('content-length') ?? 0); if (length > OUTPUT_BOUND) throw new Error('HTTP output exceeds bound');
          const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let count = 0;
          if (reader) for (;;) { const next = await reader.read(); if (next.done) break; count += next.value.length;
            if (count > OUTPUT_BOUND) { await reader.cancel(); throw new Error('HTTP output exceeds bound'); } chunks.push(next.value); }
          rawOutput = Buffer.concat(chunks).toString(); observed = rawOutput;
        } catch { actualStatus = 0; observed = 'native HTTP unavailable, redirected, timed out or oversized'; }
      }
      try { parsed = JSON.parse(rawOutput); } catch { parsed = undefined; }
      let observationMatches = false;
      switch (admission.oracle.kind) {
        case 'json-fields': observationMatches = compareJsonFields(parsed, JSON.parse(replaceInputs(JSON.stringify(admission.oracle.fields))) as Record<string, unknown>); observed = JSON.stringify(parsed ?? { unavailable: true }); break;
        case 'sql-equals': {
          const query = replaceInputs(admission.oracle.query).trim();
          if (!query.toUpperCase().startsWith('SELECT ') || query.slice(0, -1).includes(';')) throw new Error(`${file}:1: $: oracle SQL must be a single read-only SELECT`);
          const result = await command(['docker', 'compose', 'exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'training', '-d', admission.oracle.database, '-At', '-c', query], operator.fixture, operator.env, operator.budget(15_000));
          observationMatches = result.status === 0 && !result.overflow && !result.timedOut && result.stdout.trim() === replaceInputs(admission.oracle.value);
          observed = JSON.stringify({ ownExit: actualStatus, databaseExit: result.status, actualDatabase: redact(result.stdout, operator.secrets) }); break;
        }
        case 'services-ready':
          try { await operator.waitReady(); observationMatches = true; observed = JSON.stringify({ ownExit: actualStatus, servicesReady: true }); }
          catch { observed = JSON.stringify({ ownExit: actualStatus, servicesReady: false }); } break;
        case 'csv-header': observationMatches = rawOutput.split('\n')[0]?.trimEnd() === admission.oracle.columns.join(',');
          observed = JSON.stringify({ ownExit: actualStatus, header: rawOutput.split('\n')[0] ?? '' }); break;
        case 'issued-token': {
          const token = rawOutput.trim(); const parts = token.split('.');
          try { const claim = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString()) as Record<string, unknown>;
            observationMatches = parts.length === 3 && typeof claim['sub'] === 'string' && typeof claim['exp'] === 'number' && claim['exp'] > Date.now() / 1000;
          } catch { observationMatches = false; }
          const signingSecret = operator.secrets.find((secret) => secret === 'local-development-secret') ?? '';
          observationMatches = observationMatches && createHmac('sha256', signingSecret).update(`${parts[0]}.${parts[1]}`).digest('base64url') === parts[2];
          if (observationMatches) { operator.secrets.push(token); operator.inputs[admission.oracle.secretInput] = token; }
          observed = JSON.stringify({ ownExit: actualStatus, issuedToken: observationMatches, secretInput: admission.oracle.secretInput }); break;
        }
        default: throw new Error(`${file}:1: $: unsupported operator action oracle; not walked`);
      }
      const event = await operator.record(admission.action, invocation, start, actualStatus, step.expected.status, observed,
        [{ name: `typed-${admission.oracle.kind}`, passed: observationMatches }], 'structured',
        { product: plan.product, guide: guide.id, procedure: procedure.id, step: step.id, commandDigest: admission.commandDigest, prerequisitesDigest: guideDigest({ guide: guide.prerequisites, procedure: procedure.prerequisites }), expectedDigest: admission.expectedDigest, oracle: admission.oracle });
      const exported = exportGuideExecution(event, event.observed, { product: plan.product, guide, procedure: procedure.id, step: step.id, invocation: event.invocation });
      const envelopePath = join(operator.out, exported.receipt.evidence);
      await writeFile(envelopePath, JSON.stringify(redactStructured(exported.envelope, operator.secrets), null, 2), { flag: 'wx', mode: 0o600 }); receipts.push(exported.receipt);
      await writeFile(join(operator.out, 'untrusted-guide-receipts.json'), JSON.stringify(redactStructured(receipts, operator.secrets), null, 2), { mode: 0o600 });
      if (!event.passed) throw new Error(`${envelopePath}:1: $: actual native guide step failed; retained actual receipt`);
      for (const capture of admission.capture ?? []) {
        let value: unknown = parsed;
        for (const key of capture.path) value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
        if (!capture.input || (typeof value !== 'string' && typeof value !== 'number')) throw new Error(`${file}:1: $: missing actual response input ${capture.input}`);
        operator.inputs[capture.input] = String(value);
        if (guide.procedures.some((procedure) => procedure.steps.some((step) => step.inputs.some((input) => input.name === capture.input && input.secret)))) operator.secrets.push(String(value));
      }
    }
    for (const procedure of guide.procedures) for (const step of procedure.steps) if (!admitted.has(`${procedure.id}/${step.id}`)) throw new Error(`${file}:1: $: missing admission for ${procedure.id}/${step.id}; full guide is not walked`);
  }
}

/** Handoff to the host lane. This envelope is UNTRUSTED until an independent
 * operator authority admits it. Digest checks and local passed flags do not do so.
 * No source verifier may use this as proof of instruction/source correctness.
 */
export interface GuideExecutionEnvelope {
  schema: 'madarch.guide-execution@1'; run: string; product: string; guide: string;
  procedure: string; step: string; context: GuideContext; unitVersion: string; inputDigest: string;
  commandDigest: string; prerequisitesDigest: string; environment: string; cwd: string;
  at: string; actualStatus: number; observed: string; observationMatches: boolean;
  instruction: string; evidence: { path: string; sha256: string }; admission: { action: string };
  invocation: WalkInvocation; expectedDigest: string; oracle: GuideOracle;
}
export interface OperatorGuideBinding {
  product: string; guide: GuideDocument; procedure: string; step: string;
  /** Expected ACTUAL native invocation supplied by the operator, not the guide author. */
  invocation: WalkInvocation;
}
/** Pure conversion only; cannot award verified/passed status or execute anything.
 * An exact native command cannot be relabelled as a different guide instruction.
 * Host approval must also bind run/product/source/context/environment and bytes.
 */
export function exportGuideExecution(event: WalkEvidence, evidenceBytes: string, binding: OperatorGuideBinding):
  { envelope: GuideExecutionEnvelope; receipt: GuideReceipt } {
  const procedure = binding.guide.procedures.find((value) => value.id === binding.procedure);
  const step = procedure?.steps.find((value) => value.id === binding.step);
  if (!procedure || !step || !binding.product.trim()) throw new Error('operator binding must name an existing guide/procedure/step/product');
  if (!matchesCapturedEvidence(event, evidenceBytes, binding.invocation)) throw new Error('capture differs from the operator binding');
  if (step.instruction.kind !== event.invocation.kind || digest(step.instruction.content) !== (event.invocation.instructionDigest ?? digest(event.invocation.content))
    || step.cwd !== event.invocation.cwd || step.environment !== event.invocation.environment) throw new Error('actual invocation differs from the exact guide instruction/cwd/environment; leave not-walked');
  if (!event.invocation.repository || !event.invocation.commit || !event.invocation.physicalCwd || !event.invocation.deployment
    || !binding.guide.context.repositories.some((repo) => repo.name === event.invocation.repository && repo.commit === event.invocation.commit)) throw new Error('operator repository/physical cwd mapping and exact fixture commit required');
  if (!event.guideBinding || event.guideBinding.product !== binding.product || event.guideBinding.guide !== binding.guide.id
    || event.guideBinding.procedure !== procedure.id || event.guideBinding.step !== step.id
    || event.guideBinding.expectedDigest !== guideDigest(step.expected)
    || event.guideBinding.commandDigest !== guideStepDigest(binding.guide, procedure.id, step)
    || event.guideBinding.prerequisitesDigest !== guideDigest({ guide: binding.guide.prerequisites, procedure: procedure.prerequisites })) throw new Error('capture lacks the exact operator typed expected-result binding');
  const path = `evidence/${event.run}/${event.sequence}.json`;
  const envelope: GuideExecutionEnvelope = {
    schema: 'madarch.guide-execution@1', run: event.run, product: binding.product,
    guide: binding.guide.id, procedure: procedure.id, step: step.id, context: binding.guide.context,
    unitVersion: binding.guide.unitVersion, inputDigest: binding.guide.inputDigest,
    commandDigest: guideStepDigest(binding.guide, procedure.id, step),
    prerequisitesDigest: guideDigest({ guide: binding.guide.prerequisites, procedure: procedure.prerequisites }),
    environment: event.invocation.environment, cwd: event.invocation.cwd, at: event.startedAt,
    actualStatus: event.actualStatus, observed: event.observed,
    observationMatches: event.checks.length > 0 && event.checks.every((check) => check.passed),
    instruction: event.invocation.content,
    evidence: { path: event.evidence, sha256: createHash('sha256').update(evidenceBytes).digest('hex') },
    admission: { action: event.action }, invocation: event.invocation,
    expectedDigest: event.guideBinding!.expectedDigest, oracle: event.guideBinding!.oracle,
  };
  const receipt: GuideReceipt = { schema: GUIDE_RECEIPT_SCHEMA, guide: envelope.guide,
    procedure: envelope.procedure, step: envelope.step, context: envelope.context,
    unitVersion: envelope.unitVersion, inputDigest: envelope.inputDigest, commandDigest: envelope.commandDigest,
    environment: envelope.environment, prerequisitesDigest: envelope.prerequisitesDigest, cwd: envelope.cwd,
    at: envelope.at, actualStatus: envelope.actualStatus, observed: envelope.observed, evidence: path };
  return { envelope, receipt };
}

export function parseOptions(argv: readonly string[]): { mode: 'probe' | 'walk'; out: string; source: string; guidePlan?: string } {
  let mode: 'probe' | 'walk' | undefined, out = '', source = '', guidePlan: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if ((arg === '--probe-only' || arg === '--walk') && mode === undefined) mode = arg === '--walk' ? 'walk' : 'probe';
    else if (arg === '--out' && !out) out = argv[++index] ?? '';
    else if (arg === '--source-manifest' && !source) source = argv[++index] ?? '';
    else if (arg === '--guide-plan' && !guidePlan) guidePlan = argv[++index] ?? '';
    else throw new Error(`unknown/duplicate option ${arg}`);
  }
  if (!mode || !out || !source || out.startsWith('--') || source.startsWith('--') || (guidePlan !== undefined && (mode !== 'walk' || !guidePlan || guidePlan.startsWith('--')))) throw new Error('usage: bun scripts/guide-walk.ts --probe-only|--walk --out <fresh directory outside checkout> --source-manifest <parent-source.json> [--guide-plan <operator-admissions.json>]');
  return { mode, out, source, ...(guidePlan ? { guidePlan } : {}) };
}
if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = await (options.mode === 'probe' ? probe(options.out, options.source) : walk(options.out, options.source, options.guidePlan));
    console.log(JSON.stringify({ state: result.state, guideState: result.guideState ?? 'not-walked', trust: result.trust, out: resolve(options.out), failure: result.failure ?? null }));
    process.exitCode = result.state === 'passed' || result.state === 'capability-passed' ? 0 : 1;
  } catch (error) { console.error(redact(String(error))); process.exitCode = 1; }
}
