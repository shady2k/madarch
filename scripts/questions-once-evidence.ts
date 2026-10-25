/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Evidence collection for the fixture-owned questions-once walk. This is a harness, not product policy. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page, CDPSession, HTTPRequest } from 'puppeteer';
import { noEntityMessage } from '../src/knowledge/resolve.js';
import { parseStatementRef } from '../src/loop/entities.js';
import { parseTarget } from '../src/knowledge/markdown.js';

export const compareCodePoint = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export function requireWalk(holds: unknown, message: string): asserts holds {
  if (!holds) { const error = new Error(message); Error.captureStackTrace(error, requireWalk); throw error; }
}

export const HTTP_MS = 30_000;
export const CLEANUP_MS = 15_000;
/** Race the whole operation, not just response headers. Abort/cancel belongs to the caller. */
export async function deadline<T>(label: string, milliseconds: number, run: () => Promise<T>, cancel: () => void = () => {}): Promise<T> {
  requireWalk(Number.isFinite(milliseconds) && milliseconds > 0, `${label}: invalid deadline ${milliseconds}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(run), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { try { cancel(); } finally { reject(new Error(`${label}: exceeded ${milliseconds}ms`)); } }, milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
export interface InputHash { readonly path: string; readonly sha256: string }
export function hashFiles(paths: readonly string[]): readonly InputHash[] {
  return Object.freeze([...paths].sort(compareCodePoint).map((path) => Object.freeze({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })));
}
export function assertHashes(before: readonly InputHash[], after: readonly InputHash[], label: string): void {
  requireWalk(JSON.stringify(before) === JSON.stringify(after), `${label}: input paths/bytes changed: ${JSON.stringify({ before, after })}`);
}
export function resetRepositoryDocument(product: string, repo: string, path: string): InputHash {
  requireWalk(repo !== '' && !repo.includes('/') && !repo.includes('..') && !path.split('/').includes('..'), 'invalid reset repository document path');
  const root = realpathSync(join(product, 'repos', repo));
  const file = realpathSync(join(root, path));
  requireWalk(file.startsWith(root + '/') && existsSync(file), `pre-reset repository document outside its repository or missing: ${file}`);
  return hashFiles([file])[0]!;
}
export function assertResetStoreRemoved(paths: readonly string[]): void {
  for (const path of paths) requireWalk(!existsSync(path), `${path}: reset did not remove planned store`);
}
export interface MissingTarget { readonly target: string; readonly key: string; readonly documentPath?: string }
export interface ResetDocumentSource { readonly target: string; readonly repo: string; readonly path: string; readonly sha256: string }
export const missingMessage = (target: MissingTarget): string => target.documentPath === undefined ? noEntityMessage(target.key) : `no document "${target.documentPath}" in the product repository or its code repositories`;
export interface MissingFinding { readonly file: string; readonly line: number; readonly message: string }
export interface MissingRecord { readonly resolutions: readonly MissingTarget[]; readonly findings: readonly MissingFinding[] }
export type ResetAbsence = Readonly<Record<string, MissingRecord>>;
/** Only targets actually read from retained records, present before reset, and removed by this exact plan. */
export function resetMissingTargets(plan: { store: readonly string[]; agentPages: readonly string[] }, removed: readonly { file: string; id: string }[], resolutions: Record<string, any>, documents: readonly ResetDocumentSource[] = []): readonly MissingTarget[] {
  requireWalk(removed.length === plan.agentPages.length && plan.agentPages.every((file) => removed.filter((row) => row.file === file).length === 1), 'reset missing-target inputs do not match exact agent-page plan');
  const ids = new Set(removed.map((row) => row.id));
  const graphRemoved = plan.store.some((path) => path.endsWith('/graph'));
  return Object.freeze(Object.entries(resolutions).flatMap(([target, value]) => {
    requireWalk(value?.state === 'ok' && value.target === (target.startsWith('madarch:') ? target : `madarch:${parseStatementRef(target)?.page ?? target}`), `pre-reset target is not resolved: ${target}`);
    const parsed = parseTarget(target.startsWith('madarch:') ? target : `madarch:${target}`);
    const document = documents.find((row) => row.target === target);
    if (document !== undefined) {
      requireWalk(parsed.kind === 'doc' && parsed.path === document.path && /^[a-f0-9]{64}$/.test(document.sha256), `invalid pre-reset document proof: ${target}`);
      const href = new URL(value.href, 'http://fixture.test');
      const sourceMatches = href.pathname === '/k/doc' && href.searchParams.get('repo') === document.repo && href.searchParams.get('path') === document.path;
      const entityMatches = typeof value.entity === 'string' && value.entity === `doc:@${document.repo}/${document.path}${parsed.anchor === null ? '' : '#' + parsed.anchor}`;
      requireWalk(sourceMatches || entityMatches, `pre-reset document repository/path does not match: ${target}`);
      if (graphRemoved) return [Object.freeze({ target, key: document.path, documentPath: document.path })];
    }
    const key = value.entity;
    return typeof key === 'string' && (ids.has(key) || (graphRemoved && key.startsWith('code.'))) ? [Object.freeze({ target, key })] : [];
  }));
}
export function assertResolution(target: string, value: any, allowed: readonly MissingTarget[] = []): void {
  requireWalk(value && ['ok', 'broken'].includes(value.state) && value.target === (target.startsWith('madarch:') ? target : `madarch:${parseStatementRef(target)?.page ?? target}`), `invalid resolution ${target}: ${JSON.stringify(value)}`);
  const expected = allowed.find((row) => row.target === target);
  if (value.state === 'ok') { requireWalk(!expected, `reset target unexpectedly still resolves: ${target}`); return; }
  requireWalk(expected && (expected.documentPath === undefined ? value.why?.code === 'no-entity' && value.why.key === expected.key : value.why?.code === 'no-document' && value.why.path === expected.documentPath) && value.reason === missingMessage(expected), `unexpected missing target ${target}: ${JSON.stringify(value)}`);
}
export function assertFindings(actual: readonly MissingFinding[], expected: readonly MissingFinding[] = []): void {
  const canonical = (rows: readonly MissingFinding[]): string => JSON.stringify(rows.map(({ file, line, message }) => ({ file, line, message })).sort((a, b) => compareCodePoint(JSON.stringify(a), JSON.stringify(b))));
  requireWalk(canonical(actual) === canonical(expected), `unexpected page findings: ${JSON.stringify({ actual, expected })}`);
}
export interface QuestionDOM { readonly slug: string; readonly state: string }
export function assertQuestionDOM(actual: readonly QuestionDOM[], expected: readonly QuestionDOM[], label: string): void {
  const sorted = (rows: readonly QuestionDOM[]): string => JSON.stringify(rows.map(({ slug, state }) => ({ slug, state })).sort((a, b) => compareCodePoint(a.slug, b.slug)));
  requireWalk(new Set(actual.map((row) => row.slug)).size === actual.length && sorted(actual) === sorted(expected), `${label}: exact DOM questions/states differ: ${JSON.stringify({ actual, expected })}`);
}
export interface OwnedPID { readonly pid: number; readonly parent: number; readonly session: number; readonly born: string; readonly state: string }
/** Linux pod ownership: include the whole private session and observed descendants, never unrelated PIDs. */
export function ownedPIDs(rows: readonly OwnedPID[], root: number, known: ReadonlyMap<number, string>): readonly OwnedPID[] {
  const owned = new Set(rows.filter((row) => row.session === root || known.get(row.pid) === row.born).map((row) => row.pid));
  owned.add(root);
  let added = true;
  while (added) { added = false; for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); added = true; } }
  return rows.filter((row) => owned.has(row.pid) && row.state !== 'Z');
}
export function processTable(): readonly OwnedPID[] {
  return readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((name) => {
    try { const stat = readFileSync(`/proc/${name}/stat`, 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); return [{ pid: Number(name), parent: Number(fields[1]), session: Number(fields[3]), born: fields[19]!, state: fields[0]! }]; }
    catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return []; throw error; }
  });
}
export class OwnedTree {
  private readonly known = new Map<number, string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private monitorFailure: unknown;
  constructor(readonly pid: number, readonly record: (value: unknown) => void) {
    this.live(); this.timer = setInterval(() => { try { this.live(); } catch (error) { this.monitorFailure = error; } }, 100);
  }
  private live(): readonly OwnedPID[] {
    const table = processTable(); const root = table.find((row) => row.pid === this.pid);
    requireWalk(!root || !this.known.has(this.pid) || this.known.get(this.pid) === root.born, `owned PID ${this.pid} was reused; refuse to signal another process`);
    const rows = ownedPIDs(table, this.pid, this.known); for (const row of rows) this.known.set(row.pid, row.born); return rows;
  }
  async stop(graceful?: () => Promise<unknown>): Promise<void> {
    let forced = false; let gracefulFailure: unknown;
    try {
      if (graceful) { try { await deadline('owned graceful close', 10_000, graceful); } catch (error) { gracefulFailure = error; } }
      const until = performance.now() + CLEANUP_MS;
      let sentTerm = false; let termAt = 0;
      while (true) {
        const live = this.live(); if (live.length === 0) break;
        if (performance.now() >= until) { this.record({ root: this.pid, known: [...this.known], survivors: live, forced, cleanup: 'deadline exceeded' }); throw new Error(`owned process tree ${this.pid} survives cleanup: ${JSON.stringify(live)}`); }
        const signal = sentTerm && performance.now() - termAt >= 2_000 ? 'SIGKILL' : 'SIGTERM'; forced ||= signal === 'SIGKILL';
        for (const row of [...live].reverse()) { try { process.kill(row.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
        if (!sentTerm) termAt = performance.now(); sentTerm = true;
        await new Promise((done) => setTimeout(done, 250));
      }
      const survivors = this.live(); this.record({ root: this.pid, known: [...this.known], survivors, forced, gracefulFailure: String(gracefulFailure ?? '') });
      requireWalk(survivors.length === 0 && !forced && gracefulFailure === undefined && this.monitorFailure === undefined, `owned tree ${this.pid}: forced/failed cleanup; see process observation`);
    } finally { clearInterval(this.timer); }
  }
}

export interface ShotPlan { readonly key: string; readonly language: 'en' | 'ru'; readonly stage: string; readonly route: string; readonly ready: string; readonly theme: 'light' | 'dark'; readonly width: 1150 | 390; readonly entity?: string; readonly question?: string; readonly dialog?: boolean; readonly removed?: number; readonly retained?: number }

/** Compare capture assertions, not explanatory metadata, before creating any evidence. */
export function assertOnceManifest(expected: { readonly head: string; readonly sourceSha256: string; readonly screenshots: readonly ShotPlan[] }, plan: readonly ShotPlan[], identity: { readonly head: string; readonly sourceSha256: string }): void {
  requireWalk(typeof expected.head === 'string' && expected.head === identity.head, 'frozen touched-page manifest head differs from runtime source before capture');
  requireWalk(typeof expected.sourceSha256 === 'string' && expected.sourceSha256 === identity.sourceSha256, 'frozen touched-page manifest sourceSha256 differs from runtime source before capture');
  const canonical = (rows: readonly ShotPlan[]): string => {
    requireWalk(Array.isArray(rows), 'frozen touched-page manifest requires screenshots before capture');
    requireWalk(new Set(rows.map((row) => row.key)).size === rows.length, 'duplicate touched-page manifest observation before capture');
    return JSON.stringify([...rows].sort((a, b) => compareCodePoint(a.key, b.key)).map(({ key, language, theme, width, stage, route, ready, entity, question, dialog, removed, retained }) => ({ key, language, theme, width, stage, route, ready, entity, question, dialog, removed, retained })));
  };
  requireWalk(canonical(expected.screenshots) === canonical(plan), 'frozen touched-page manifest differs from runtime plan before capture');
}


/** Only this page's same-origin product change feed is intentionally long lived. */
export function expectedEventSource(pageURL: string, url: string, method: string): boolean {
  try {
    const page = new URL(pageURL); const request = new URL(url);
    const product = /^(\/products\/[^/]+)\/k(?:\/|$)/.exec(page.pathname)?.[1];
    return product !== undefined && request.origin === page.origin && request.pathname === `${product}/api/events` && request.search === '' && method === 'GET';
  } catch { return false; }
}

export function measureVisibility(dialog: boolean) {
        const root = document.querySelector(dialog ? '[data-testid=danger-dialog]' : '[data-testid=knowledge-main]');
        if (!root) throw new Error('measurement root missing');
        const selectors = 'h1,h2,h3,p,li,summary,button,blockquote,textarea,[data-testid=question-text],[data-testid=question-why],[data-testid=answer-quote]';
        const rows = [...root.querySelectorAll(selectors)].filter((element) => {
          if ((element.textContent?.trim() ?? '') === '' && element.tagName !== 'TEXTAREA') return false;
          // A closed native disclosure lays out descendants without painting them.
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (parent.tagName !== 'DETAILS' || (parent as HTMLDetailsElement).open) continue;
            const summary = parent.querySelector(':scope > summary');
            if (summary === null || !summary.contains(element)) return false;
          }
          return true;
        });
        const labels = rows.map((element) => {
          const box = element.getBoundingClientRect(); const style = getComputedStyle(element);
          const clips: unknown[] = []; let hidden = false;
          for (let parent: Element | null = element; parent; parent = parent.parentElement) {
            const css = getComputedStyle(parent); hidden ||= css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) === 0;
            if (parent === element) continue;
            const bound = parent.getBoundingClientRect();
            const xClips = ['hidden', 'clip', 'auto', 'scroll'].includes(css.overflowX);
            const yClips = ['hidden', 'clip', 'auto', 'scroll'].includes(css.overflowY);
            if ((xClips && (box.left < bound.left - 1 || box.right > bound.right + 1)) || (yClips && (box.top < bound.top - 1 || box.bottom > bound.bottom + 1))) clips.push({ tag: parent.tagName, testid: parent.getAttribute('data-testid'), overflowX: css.overflowX, overflowY: css.overflowY, bounds: { x: bound.x, y: bound.y, width: bound.width, height: bound.height }, scrollWidth: parent.scrollWidth, scrollHeight: parent.scrollHeight });
          }
          const ownClip = ((element as HTMLElement).scrollWidth > element.clientWidth + 1 && ['hidden','clip','auto','scroll'].includes(style.overflowX)) || ((element as HTMLElement).scrollHeight > element.clientHeight + 1 && ['hidden','clip','auto','scroll'].includes(style.overflowY));
          const special = element.closest('[data-testid=question-row],[data-testid=question-page],[data-testid=danger-dialog]') !== null;
          return { label: element.textContent, tag: element.tagName, x: box.x, y: box.y, width: box.width, height: box.height, fontSize: Number.parseFloat(style.fontSize), fontFamily: style.fontFamily, lineHeight: style.lineHeight, hidden, ownClip, clips, special };
        });
        const overlaps: unknown[] = [];
        for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
          const a = rows[i]!; const b = rows[j]!; if (a.contains(b) || b.contains(a)) continue;
          const aa = a.getBoundingClientRect(); const bb = b.getBoundingClientRect();
          const width = Math.min(aa.right, bb.right) - Math.max(aa.left, bb.left); const height = Math.min(aa.bottom, bb.bottom) - Math.max(aa.top, bb.top);
          if (width > 2 && height > 2) overlaps.push({ first: a.textContent, second: b.textContent, width, height });
        }
        const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface-page').trim();
        return { width: innerWidth, viewportHeight: innerHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight, labels, overlaps, fonts: document.fonts.status, interLoaded: document.fonts.check('18px Inter'), surface, dark: matchMedia('(prefers-color-scheme: dark)').matches, language: localStorage.getItem('madarch-wiki-language'), homeLabel: document.querySelector('[data-testid=nav-home]')?.textContent?.trim() };
}

export interface VisibilityMeasurement {
  readonly labels: readonly { readonly hidden: boolean; readonly width: number; readonly height: number; readonly fontSize: number; readonly clips: readonly unknown[]; readonly ownClip: boolean; readonly special: boolean; readonly x: number }[];
  readonly overlaps: readonly unknown[]; readonly documentWidth: number; readonly fonts: string; readonly interLoaded: boolean; readonly dark: boolean; readonly surface: string; readonly language: string | null; readonly homeLabel: string | undefined;
}
export function assertVisibility(measurement: VisibilityMeasurement, shot: Pick<ShotPlan, 'key' | 'width' | 'theme' | 'language'>): void {
  requireWalk(measurement.labels.length > 0 && measurement.labels.every((row) => !row.hidden && row.width > 0 && row.height > 0 && row.fontSize >= 14 && row.clips.length === 0 && !row.ownClip), `${shot.key}: hidden, clipped or unreadable labels; see visibility-measured`);
  requireWalk(measurement.labels.filter((row) => row.special).every((row) => row.x >= -1 && row.x + row.width <= shot.width + 1), `${shot.key}: changed surface overflows viewport`);
  requireWalk(measurement.overlaps.length === 0 && measurement.documentWidth <= shot.width + 1, `${shot.key}: overlap/horizontal overflow; see visibility-measured`);
  const surface = measurement.surface.toLowerCase().replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/, '#$1$1$2$2$3$3');
  requireWalk(measurement.fonts === 'loaded' && measurement.interLoaded && measurement.dark === (shot.theme === 'dark') && surface === (shot.theme === 'dark' ? '#292929' : '#ffffff'), `${shot.key}: actual font/theme differs from plan`);
  requireWalk(measurement.language === shot.language && measurement.homeLabel === (shot.language === 'ru' ? 'Главная' : 'Home'), `${shot.key}: actual language differs from plan`);
}

export interface RouteIdentity { readonly entity?: string | null; readonly question?: string | null; readonly state?: string | null; readonly rows: readonly QuestionDOM[]; readonly overviewReady: boolean; readonly settingsReady: boolean }
export function assertRouteIdentity(path: string, identity: RouteIdentity, shot: ShotPlan, questions: readonly QuestionDOM[]): void {
  requireWalk(path === shot.route, `${shot.key}: browser route is ${path}, not ${shot.route}`);
  if (shot.stage === 'empty-home') requireWalk(identity.overviewReady, `${shot.key}: empty overview content missing`);
  if (shot.route.endsWith('/settings')) requireWalk(identity.settingsReady, `${shot.key}: settings content missing`);
  if (shot.entity) requireWalk(identity.entity === shot.entity, `${shot.key}: expected entity ${shot.entity}, got ${identity.entity}`);
  if (shot.question) {
    const expected = questions.find((row) => row.slug === shot.question);
    requireWalk(expected && identity.question === expected.slug && identity.state === expected.state, `${shot.key}: detail identity/state mismatch: ${JSON.stringify(identity)}`);
  }
  if (shot.route.endsWith('/questions')) assertQuestionDOM(identity.rows, questions, shot.key);
}

export class OnceEvidence {
  private serial = 0;
  private eventSerial = 0;
  private readonly pending = new Set<Promise<void>>();
  private readonly completed = new Set<string>();
  private readonly finite = new Map<Page, Map<HTTPRequest, { url: string; method: string; type: string }>>();
  private readonly streams = new Map<Page, Set<HTTPRequest>>();
  private readonly errors: string[] = [];
  private readonly closing = new WeakSet<Page>();
  private readonly sessions = new Map<Page, CDPSession>();
  private inputsVerified = false;
  verifyInputs(): void { this.inputsVerified = true; }
  constructor(readonly out: string, readonly plan: readonly ShotPlan[], readonly inputs: unknown) {
    requireWalk(new Set(plan.map((shot) => shot.key)).size === plan.length, 'duplicate immutable planned screenshot keys');
    mkdirSync(join(out, 'raw'), { recursive: true });
    mkdirSync(join(out, 'observations'), { recursive: true });
    mkdirSync(join(out, 'shots'), { recursive: true });
    this.immutable('planned.json', { task: 'madarch-m38l.22', status: 'PLANNED, NOT RUN', inputs, screenshots: plan, pageMode: 'full=1', questionDetail: 'id=<slug>', fixture: 'generated training repository + scripted ACP only', visualReview: 'pending coordinator vision' });
  }
  immutable(path: string, value: unknown): void {
    writeFileSync(join(this.out, path), JSON.stringify(value, null, 2), { flag: 'wx' });
  }
  observe(kind: string, value: unknown): void {
    this.immutable(`observations/${String(++this.eventSerial).padStart(6, '0')}.json`, { at: new Date().toISOString(), kind, value });
  }
  private async raw(url: string, source: string, run: () => Promise<{ status: number; headers: Record<string, string>; bytes: Uint8Array }>): Promise<{ status: number; bytes: Uint8Array }> {
    const name = String(++this.serial).padStart(7, '0');
    const began = performance.now();
    try {
      const result = await run();
      writeFileSync(join(this.out, 'raw', `${name}.bin`), result.bytes, { flag: 'wx' });
      this.immutable(`raw/${name}.json`, { source, url, status: result.status, headers: result.headers, bytes: result.bytes.byteLength, milliseconds: performance.now() - began, sha256: createHash('sha256').update(result.bytes).digest('hex') });
      return result;
    } catch (error) {
      this.immutable(`raw/${name}.error.json`, { source, url, milliseconds: performance.now() - began, error: String(error), stack: error instanceof Error ? error.stack : undefined });
      throw error;
    }
  }
  async json(url: string, init?: RequestInit, milliseconds = HTTP_MS): Promise<any> {
    this.observe('request-planned', { url, method: init?.method ?? 'GET', body: init?.body, headers: init?.headers });
    const result = await this.raw(url, init?.method ?? 'GET', async () => {
      const controller = new AbortController();
      return await deadline(`${url}: finite HTTP body`, milliseconds, async () => {
        const response = await fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
        this.observe('http-headers', { url, status: response.status, headers: Object.fromEntries(response.headers) });
        return { status: response.status, headers: Object.fromEntries(response.headers), bytes: new Uint8Array(await response.arrayBuffer()) };
      }, () => controller.abort());
    });
    const text = new TextDecoder().decode(result.bytes);
    let body: any;
    try { body = JSON.parse(text); } catch (error) { throw new Error(`${url}: non-JSON HTTP ${result.status}; raw bytes retained: ${error}`); }
    requireWalk(result.status >= 200 && result.status < 300, `${url}: HTTP ${result.status}: ${text}`);
    return body;
  }
  async waitFinite(page: Page, milliseconds = HTTP_MS): Promise<void> {
    let cancelled = false;
    try {
      await deadline('finite browser requests', milliseconds, async () => {
        let quietSince = performance.now();
        while (!cancelled && performance.now() - quietSince < 500) {
          if ((this.finite.get(page)?.size ?? 0) !== 0) quietSince = performance.now();
          await new Promise((done) => setTimeout(done, 25));
        }
        if (!cancelled) await this.flush();
      }, () => { cancelled = true; });
    } catch (error) {
      const requests = [...(this.finite.get(page)?.values() ?? [])];
      this.observe('finite-requests-incomplete', { url: page.url(), requests, knownEventSources: this.streams.get(page)?.size ?? 0 });
      throw new Error(`${String(error)}; unfinished finite requests: ${JSON.stringify(requests)}`);
    }
  }
  watch(page: Page): void {
    const finite = new Map<HTTPRequest, { url: string; method: string; type: string }>();
    const streams = new Set<HTTPRequest>(); this.finite.set(page, finite); this.streams.set(page, streams);
    page.on('request', (request) => {
      if (request.resourceType() === 'eventsource' && expectedEventSource(page.url(), request.url(), request.method())) { streams.add(request); return; }
      if (request.resourceType() === 'eventsource') this.errors.push(`${request.url()}: unexpected EventSource endpoint or method`);
      finite.set(request, { url: request.url(), method: request.method(), type: request.resourceType() });
    });
    page.on('requestfinished', (request) => { finite.delete(request); streams.delete(request); });
    page.on('pageerror', (error) => { const message = error instanceof Error ? error.message : String(error); this.errors.push(message); this.observe('pageerror', { url: page.url(), error: message, stack: error instanceof Error ? error.stack : undefined }); });
    page.on('requestfailed', (request) => {
      const knownStream = streams.has(request); finite.delete(request); streams.delete(request);
      const intentionalStreamClose = this.closing.has(page) && knownStream && request.failure()?.errorText === 'net::ERR_ABORTED';
      const detail = { url: request.url(), failure: request.failure(), classification: intentionalStreamClose ? 'intentional SSE abort on navigation/close' : 'unexpected failure' };
      if (!intentionalStreamClose) this.errors.push(JSON.stringify(detail)); this.observe('requestfailed', detail);
    });
    page.on('response', (response) => {
      if (!response.url().startsWith('http')) return;
      if (response.status() >= 400) this.errors.push(`${response.url()}: HTTP ${response.status()}`);
      const streaming = response.headers()['content-type']?.includes('text/event-stream');
      const knownStream = streams.has(response.request()) && expectedEventSource(page.url(), response.url(), response.request().method());
      if (streaming && !knownStream) this.errors.push(`${response.url()}: unexpected streaming response`);
      if (streaming && knownStream && response.status() < 400) { this.observe('SSE-response', { url: response.url(), status: response.status(), headers: response.headers(), rawBody: 'stream is not a finite page response; status polling is retained separately' }); return; }
      this.observe('browser-http-headers', { url: response.url(), status: response.status(), headers: response.headers() });
      const task = this.raw(response.url(), 'browser', async () => ({ status: response.status(), headers: response.headers(), bytes: new Uint8Array(await deadline(`${response.url()}: browser response body`, HTTP_MS, () => response.content(), () => { void this.sessions.get(page)?.send('Page.stopLoading').catch(() => {}); })) }))
        .then(() => {})
        .catch((error) => { this.errors.push(String(error)); });
      this.pending.add(task); void task.finally(() => this.pending.delete(task));
    });
  }
  async flush(): Promise<void> {
    await deadline('browser evidence drain', HTTP_MS + CLEANUP_MS, async () => { while (this.pending.size > 0) await Promise.all([...this.pending]); });
  }
  async closePage(page: Page): Promise<void> {
    this.closing.add(page);
    const failures: unknown[] = [];
    const session = this.sessions.get(page);
    // Capture is already complete. Freeze new timers, not network or Node-side evidence.
    try { if (session) await deadline('pause page timers after capture', CLEANUP_MS, () => session.send('Emulation.setScriptExecutionDisabled', { value: true })); } catch (error) { failures.push(error); }
    try { await this.waitFinite(page); } catch (error) { failures.push(error); }
    // Even a bounded drain failure must close the page and stay an error.
    try { if (session) await deadline('CDP stop loading', CLEANUP_MS, () => session.send('Page.stopLoading')); } catch (error) { failures.push(error); }
    try { if (session) await deadline('CDP detach', CLEANUP_MS, () => session.detach()); } catch (error) { failures.push(error); }
    try { if (!page.isClosed()) await deadline('browser page close', CLEANUP_MS, () => page.close()); } catch (error) { failures.push(error); }
    this.sessions.delete(page);
    this.finite.delete(page); this.streams.delete(page);
    try { await this.flush(); } catch (error) { failures.push(error); }
    requireWalk(failures.length === 0, `page cleanup failed: ${failures.map(String).join('; ')}`);
  }
  async closePages(): Promise<void> {
    const results = await Promise.allSettled([...this.sessions.keys()].map((page) => this.closePage(page)));
    requireWalk(results.every((result) => result.status === 'fulfilled'), `page cleanup incomplete: ${JSON.stringify(results.map((result) => result.status === 'rejected' ? String(result.reason) : 'closed'))}`);
  }
  async stream(page: Page): Promise<void> {
    const session = await deadline('create CDP session', CLEANUP_MS, () => page.createCDPSession());
    this.sessions.set(page, session);
    session.on('Network.eventSourceMessageReceived', (event) => this.observe('SSE-raw-message', event));
    await deadline('enable CDP network', CLEANUP_MS, () => session.send('Network.enable'));
  }
  async shot(browser: Browser, origin: string, shot: ShotPlan, questions: readonly QuestionDOM[]): Promise<void> {
    await deadline(`${shot.key}: complete browser capture`, 240_000, () => this.capture(browser, origin, shot, questions), () => { void this.closePages().catch((error) => { this.errors.push(String(error)); }); });
  }
  private async capture(browser: Browser, origin: string, shot: ShotPlan, questions: readonly QuestionDOM[]): Promise<void> {
    requireWalk(this.plan.some((entry) => entry.key === shot.key) && !this.completed.has(shot.key), `unplanned or repeated screenshot ${shot.key}`);
    const page = await deadline('new browser page', HTTP_MS, () => browser.newPage()); this.watch(page); await this.stream(page);
    try {
      await page.evaluateOnNewDocument((language) => localStorage.setItem('madarch-wiki-language', language), shot.language);
      await page.setViewport({ width: shot.width, height: 900 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: shot.theme }]);
      const response = await page.goto(`${origin}${shot.route}`, { waitUntil: 'domcontentloaded' });
      requireWalk(response?.ok(), `${origin}${shot.route}: browser navigation failed`);
      await page.waitForSelector(shot.ready, { timeout: 120_000, visible: true });
      if (shot.dialog) {
        await page.click('[data-testid=danger-fresh-open]');
        await page.waitForSelector('[data-testid=danger-answers]', { timeout: 60_000 });
        const text = await page.$eval('[data-testid=danger-dialog]', (element) => element.textContent ?? '');
        const removed = await page.$eval('[data-testid=danger-questions]', (element) => element.textContent ?? '');
        const retained = await page.$eval('[data-testid=danger-answers]', (element) => element.textContent ?? '');
        requireWalk(new RegExp(`(^|\\D)${shot.removed}(\\D|$)`).test(removed), `reset dialog removed count ${shot.removed}: ${removed}`);
        requireWalk(new RegExp(`(^|\\D)${shot.retained}(\\D|$)`).test(retained), `reset dialog retained count ${shot.retained}: ${retained}`);
        this.observe('reset-dialog', { key: shot.key, text, removed, retained });
      }
      await page.waitForFunction(() => document.querySelector('[data-testid=page-loading], [data-testid=block-loading], [data-testid=block-deferred], [data-testid=page-error]') === null, { timeout: 180_000 });
      await deadline('document fonts ready', HTTP_MS, () => page.evaluate(() => document.fonts.ready.then(() => undefined)));
      await this.waitFinite(page);
      const identity = await page.evaluate(() => ({
        entity: document.querySelector('[data-testid=entity-page]')?.getAttribute('data-entity'),
        question: document.querySelector('[data-testid=question-page]')?.getAttribute('data-question'),
        state: document.querySelector('[data-testid=question-page]')?.getAttribute('data-state'),
        overviewReady: document.querySelector('[data-testid=overview] [data-testid=fill-card] [data-testid=fill-start]') !== null,
        settingsReady: document.querySelector('[data-testid=settings-page]') !== null,
        rows: [...document.querySelectorAll('[data-testid=question-row]')].map((row) => ({ slug: row.getAttribute('data-question') ?? '', state: row.getAttribute('data-state') ?? '' })),
      }));
      assertRouteIdentity(new URL(page.url()).pathname, identity, shot, questions);
      const measurement = await page.evaluate(measureVisibility, shot.dialog === true);
      this.observe('visibility-measured', { key: shot.key, measurement });
      assertVisibility(measurement, shot);
      requireWalk(!await page.$('[data-testid=page-error], [data-testid=block-problem]'), `${shot.route}: rendered problem block`);
      await page.screenshot({ path: join(this.out, 'shots', `${shot.key}.png`), fullPage: true, captureBeyondViewport: true });
      const bytes = readFileSync(join(this.out, 'shots', `${shot.key}.png`));
      const image = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      requireWalk(image.width >= measurement.documentWidth && image.height >= measurement.documentHeight, `${shot.key}: screenshot clipped; image ${image.width}x${image.height}, document ${measurement.documentWidth}x${measurement.documentHeight}`);
      this.observe('screenshot-completed', { ...shot, fullPage: true, measurement, image, visualReview: 'NOT REVIEWED' });
      this.completed.add(shot.key);
    } finally { await this.closePage(page); }
  }
  finish(cleaned: boolean, failure?: unknown): boolean {
    this.immutable('result.json', { complete: cleaned && this.inputsVerified && failure === undefined && this.errors.length === 0 && this.completed.size === this.plan.length, cleaned, inputsVerified: this.inputsVerified, inputs: this.inputs, planned: this.plan.length, completed: [...this.completed].sort(compareCodePoint), missing: this.plan.filter((shot) => !this.completed.has(shot.key)).map((shot) => shot.key), errors: this.errors, failure: failure === undefined ? undefined : { message: String(failure), stack: failure instanceof Error ? failure.stack : undefined }, visualReview: 'PENDING; numeric capture is not vision acceptance' });
    return cleaned && this.inputsVerified && failure === undefined && this.errors.length === 0 && this.completed.size === this.plan.length;
  }
}

/** All declared kinds, every pagination batch, then all touched page bodies and question detail routes. No sample. */
export async function inventory(evidence: OnceEvidence, base: string, language: 'en' | 'ru', stage: string, expectedIds: readonly string[], absence: ResetAbsence = {}): Promise<void> {
  const status = await evidence.json(`${base}/api/k/status`);
  requireWalk(Array.isArray(status.kinds) && new Set(status.kinds.map((kind: any) => kind.kind)).size === status.kinds.length && status.kinds.every((kind: any) => typeof kind.kind === 'string' && Number.isInteger(kind.count) && kind.count >= 0), 'unknown or duplicate status kind schema');
  const inventoryIds = new Set<string>();
  const kinds: unknown[] = [];
  for (const kind of [...status.kinds].sort((a, b) => compareCodePoint(a.kind, b.kind))) {
    const seen = new Set<string>(); const cursors = new Set<string>(); let after: string | null = null; let total: number | undefined; let batches = 0;
    do {
      const query = new URLSearchParams({ kind: kind.kind, limit: '37' }); if (after !== null) query.set('after', after);
      const list = await evidence.json(`${base}/api/k/entities?${query}`); batches += 1;
      requireWalk(list.kind === kind.kind && Number.isInteger(list.total) && list.total >= 0 && Array.isArray(list.rows), `invalid inventory for ${kind.kind}`);
      requireWalk(total === undefined || total === list.total, `inventory count changed during pagination: ${kind.kind}`); total = list.total;
      requireWalk(list.rows.length <= 37 && (list.next === null || typeof list.next === 'string'), `invalid pagination shape: ${kind.kind}`);
      for (const row of list.rows) {
        requireWalk(typeof row.id === 'string' && row.id.length > 0 && !seen.has(row.id), `missing/duplicate id in ${kind.kind}: ${row.id}`);
        seen.add(row.id); if (['product', 'domain', 'question', 'correction'].includes(kind.kind)) inventoryIds.add(row.id);
      }
      requireWalk(seen.size <= total!, `count overflow in ${kind.kind}`);
      if (list.next !== null) {
        requireWalk(seen.size < total!, `next cursor after declared end of ${kind.kind}`);
        requireWalk(list.rows.length > 0 && !cursors.has(list.next) && list.next !== after, `empty/repeated/nonadvancing next in ${kind.kind}: ${list.next}`);
        cursors.add(list.next);
      }
      after = list.next;
    } while (after !== null);
    requireWalk(seen.size === total && total === kind.count, `incomplete ${kind.kind}: status ${kind.count}, total ${total}, unique ${seen.size}`);
    kinds.push({ kind: kind.kind, total, batches, ids: [...seen].sort(compareCodePoint) });
  }
  const actual = [...inventoryIds].sort(compareCodePoint);
  requireWalk(JSON.stringify(actual) === JSON.stringify([...expectedIds].sort(compareCodePoint)), `touched inventory mismatch at ${stage}: expected ${JSON.stringify(expectedIds)} actual ${JSON.stringify(actual)}`);
  const pages: unknown[] = [];
  for (const id of actual) {
    const page = await evidence.json(`${base}/api/k/page?${new URLSearchParams({ id, lang: language, full: '1' })}`);
    requireWalk(page.id === id && Array.isArray(page.blocks) && Array.isArray(page.findings) && page.resolutions !== null && typeof page.resolutions === 'object', `page body.id/schema is not exact: requested ${id}, got ${JSON.stringify(page)}`);
    pages.push({ id, page });
    assertFindings(page.findings, absence[id]?.findings);
    const inspect = (value: any): void => {
      if (value === null || typeof value !== 'object') return;
      requireWalk(value.type !== 'problem' && value.type !== 'deferred', `HTTP 200 problem/deferred block on ${id}: ${JSON.stringify(value)}`);
      for (const child of Object.values(value)) inspect(child);
    }; inspect(page);
    for (const [target, resolution] of Object.entries(page.resolutions) as [string, any][]) {
      assertResolution(target, resolution, absence[id]?.resolutions);
      if (resolution.state === 'broken') evidence.observe('reset-missing-target', { stage, id, target, resolution, expected: absence[id] });
    }
    if (id.startsWith('question:')) {
      const slug = id.slice('question:'.length);
      const detail = await evidence.json(`${base}/api/k/question?id=${encodeURIComponent(slug)}`);
      requireWalk(detail.id === id && detail.slug === slug && ['open', 'answered', 'closed'].includes(detail.state) && Array.isArray(detail.sides) && detail.resolutions !== null && typeof detail.resolutions === 'object', `question detail schema/id mismatch: ${id}`);
      requireWalk(detail.sides.length > 0 && detail.sides.every((side: any) => Array.isArray(side.grounds) && side.grounds.length > 0 && side.grounds.every((ground: string) => Object.hasOwn(detail.resolutions, ground))), `incomplete question grounds/resolutions ${id}`);
      evidence.observe('question-detail-checked', { stage, id, state: detail.state, grounds: detail.sides, resolutions: detail.resolutions });
      for (const [ground, resolution] of Object.entries(detail.resolutions) as [string, any][]) {
        assertResolution(ground, resolution, absence[id]?.resolutions);
      }
    }
  }
  evidence.immutable(`${language}-${stage}-every-page.json`, { language, stage, independentOfScreenshots: true, kinds, ids: actual, pages });
  evidence.observe('inventory-completed', { language, stage, kinds, ids: actual });
}
