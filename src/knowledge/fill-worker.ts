/**
 * The fill worker (madarch-m38l.4, remark 3): `madarch knowledge-fill-worker`.
 * It owns one product's primary graph store while a fill runs, reads the
 * repositories into it one commit at a time, makes a snapshot of the store
 * between commits for the server to read (`fill-protocol.ts` says why), and,
 * when asked, runs the writer's non-agent work: the content ingest, the
 * prompts, the tools and the checks. The agent itself runs in the server, which
 * the worker asks for each unit and which answers the unit's tool calls here.
 *
 * It runs the extract driver through its public entry `fillGraph` and reads
 * nothing else of the driver.
 */
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setPriority } from 'node:os';
import { promisify } from 'node:util';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../adapters/database-owner.js';
import { fillGraph } from '../extract/driver/index.js';
import { repositoryLandmarks } from './history-landmarks.js';
import { HISTORY_EXTRACTOR, OWNERS, TREE_EXTRACTORS } from '../extract/driver/extractors.js';
import { createGraphStore } from '../graph/index.js';
import { indexWorkerProduct } from './index/run.js';
import { markResolved } from '../loop/answer.js';
import { briefsFor, neededFrom, neededFromPaths, planRefresh } from '../loop/plan.js';
import { planTaskRun } from '../loop/task-run.js';
import type { EditBrief } from '../writer/edit.js';
import type { UnitsInput, UnitsNeeded } from '../writer/run.js';
import { fillWriterState, fsSink, PRODUCT_PATH, productSlug, runWriter, type ToolClient, type UnitAgent } from '../writer/index.js';
import { parseMessage, type FromWorker, type RepositoryPin, type ToWorker, type WorkerStart } from './fill-protocol.js';
import { readKinds } from './kinds.js';
import { DOCUMENT_LIMIT, listedDocument, productDocumentPaths, readProductDocument, readRepoDocuments, repoDocumentPaths } from './doc-sources.js';
import { readDocEntities, type DocumentSource } from './doc-entities.js';
import { IDENTITIES_FILE, readDocIdentities, sameDocIdentities, writeDocIdentities } from './doc-identities.js';
import { CLASSIFICATIONS_FILE, readClassificationStore, storedClassifier } from './semantics.js';
import { createGitSnapshotSource } from '../fill/snapshot.js';
import { createGuideWriter, guideProductPin, type GuideWriterWiring } from '../writer/guides/writer.js';

/** The fill's guide factory derives withholding/refusal authority from its actual pinned evidence.
 * A host checker, when supplied, stays additive; no caller passes an empty substitute authority. */
export async function createFillGuideWriter(wiring: GuideWriterWiring) {
  return await createGuideWriter(wiring);
}

const execFileAsync = promisify(execFile);

class FillStopped extends Error {}

/** The numbers of the snapshots already in `readRoot`, so a new one never reuses one. */
export function snapshotNumbers(readRoot: string): number[] {
  try {
    return readdirSync(readRoot).filter((name) => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Makes the folder of a snapshot of a store the owner holds: a checkpoint, then a copy that lands whole or not at all. */
export async function takeSnapshot(owner: DatabaseOwner, graphPath: string, readRoot: string): Promise<number> {
  await owner.exec('CHECKPOINT');
  mkdirSync(readRoot, { recursive: true });
  const seq = (snapshotNumbers(readRoot).pop() ?? 0) + 1;
  const temporary = join(readRoot, `${seq}.tmp`);
  rmSync(temporary, { recursive: true, force: true });
  cpSync(graphPath, temporary, { recursive: true });
  renameSync(temporary, join(readRoot, String(seq)));
  return seq;
}

export async function runFillWorker(io: { lines: AsyncIterable<string>; send: (message: FromWorker) => void }): Promise<number> {
  const { send } = io;
  const iterator = io.lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done === true) return 0;
  const start = parseMessage<ToWorker>(first.value, 'the server');
  if (start.type !== 'start') throw new Error(`src/knowledge/fill-worker.ts: the first message of the server is ${JSON.stringify(start.type)}, not "start"`);

  let stopping = false;
  const waiting = new Map<string, { resolve: () => void; reject: (error: Error) => void; tools: ToolClient }>();
  let agentAnswer: ((answer: { ok: true } | { ok: false; message: string }) => void) | undefined;
  const endAll = (reason: string): void => {
    stopping = true;
    for (const entry of waiting.values()) entry.reject(new Error(reason));
    waiting.clear();
    agentAnswer?.({ ok: false, message: reason });
  };
  const handle = (message: ToWorker): void => {
    switch (message.type) {
      case 'stop': endAll('the fill worker was stopped'); return;
      case 'agent-ready': agentAnswer?.({ ok: true }); return;
      case 'agent-failed': agentAnswer?.({ ok: false, message: message.message }); return;
      case 'unit-end': {
        const entry = waiting.get(message.id);
        waiting.delete(message.id);
        if (entry === undefined) return;
        if (message.error === undefined) entry.resolve(); else entry.reject(new Error(message.error));
        return;
      }
      case 'tool': {
        // A tool call of the unit the server's agent is running: answered by the unit's own tools here.
        const entry = waiting.get(message.unit);
        if (entry === undefined) {
          send({ type: 'tool-result', callId: message.callId, answer: { isError: true, answer: { error: 'no-such-unit', message: `the unit ${message.unit} is not running` } }, finished: true });
          return;
        }
        entry.tools.call(message.name, message.args).then(
          (answer) => send({ type: 'tool-result', callId: message.callId, answer, finished: entry.tools.finished() }),
          (error: unknown) => send({ type: 'tool-result', callId: message.callId, answer: { isError: true, answer: { error: 'tool-failed', message: error instanceof Error ? error.message : String(error) } }, finished: entry.tools.finished() }),
        );
        return;
      }
      default: return;
    }
  };
  void (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        endAll('the server closed the pipe');
        return;
      }
      handle(parseMessage<ToWorker>(next.value, 'the server'));
    }
  })();

  // The fill is the long work and a page is the quick one: on a machine with few cores the page gets the processor first.
  try {
    setPriority(0, 19);
  } catch {
    // a platform that does not let a process lower its own priority runs the fill at the priority it has
  }
  const { productFolder, graphPath, readRoot, repositories } = start;
  mkdirSync(graphPath.replace(/[/\\][^/\\]*$/, ''), { recursive: true });
  const owner = createPGliteDatabaseOwner({ path: graphPath, btreeGist: true });
  try {
    await owner.ready;
    const store = createGraphStore(owner);
    await store.createSchema();
    const pins = new Map<string, RepositoryPin>();
    await owner.transaction('write', async (tx) => {
      await tx.query(`CREATE TABLE IF NOT EXISTS knowledge_fill (
        repo text PRIMARY KEY, scope text NOT NULL, head text NOT NULL, commit_hash text NOT NULL, effective_time text NOT NULL,
        commits int NOT NULL, filled_commits int NOT NULL)`);
      await tx.query(`CREATE TABLE IF NOT EXISTS knowledge_history_landmarks (
        repo text PRIMARY KEY, scope text NOT NULL, head text NOT NULL, plan jsonb NOT NULL)`);
      const rows = await tx.query<Record<string, unknown>>('SELECT repo, scope, head, commit_hash, effective_time, commits, filled_commits FROM knowledge_fill');
      for (const row of rows.rows) {
        pins.set(String(row['repo']), {
          name: String(row['repo']), scope: String(row['scope']), head: String(row['head']), commit: String(row['commit_hash']),
          effectiveTime: String(row['effective_time']), commits: Number(row['commits']), filledCommits: Number(row['filled_commits']),
        });
      }
    });
    let lastSnapshot = 0;
    const snapshot = async (force: boolean): Promise<void> => {
      if (!force && Date.now() - lastSnapshot < start.snapshotMs) return;
      const seq = await takeSnapshot(owner, graphPath, readRoot);
      lastSnapshot = Date.now();
      send({ type: 'snapshot', seq, pins: [...pins.values()] });
    };
    const pin = async (next: RepositoryPin): Promise<void> => {
      pins.set(next.name, next);
      await owner.run((tx) => tx.query(
        `INSERT INTO knowledge_fill (repo, scope, head, commit_hash, effective_time, commits, filled_commits) VALUES ($1, $2, $3, $4, $5, $6::int, $7::int)
         ON CONFLICT (repo) DO UPDATE SET scope = $2, head = $3, commit_hash = $4, effective_time = $5, commits = $6::int, filled_commits = $7::int`,
        [next.name, next.scope, next.head, next.commit, next.effectiveTime, String(next.commits), String(next.filledCommits)],
      ));
    };

    // ---- the fill -------------------------------------------------------------------------
    let gaps = 0;
    try {
      for (const repo of repositories) {
        send({ type: 'progress', repository: repo.name, commit: 0, commits: 0 });
        const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo.path, encoding: 'utf8' })).stdout.trim();
        // A refill walks the history from its first commit again: the source pin only moves forward, past what was already read.
        const base = pins.get(repo.name)?.filledCommits ?? 0;
        const landmarks = await repositoryLandmarks(repo.path, head);
        const report = await fillGraph({
          owner,
          store,
          repository: repo.path,
          ref: head,
          extractors: TREE_EXTRACTORS,
          owners: OWNERS,
          history: HISTORY_EXTRACTOR,
          snapshots: landmarks.snapshots,
          points: landmarks.points,
          onStart: async (began) => {
            await pin({ name: repo.name, scope: began.repositoryNode, head: began.head, commit: pins.get(repo.name)?.commit ?? '', effectiveTime: pins.get(repo.name)?.effectiveTime ?? '', commits: began.commits, filledCommits: base });
            await owner.transaction('write', async (tx) => {
              await tx.query(`INSERT INTO knowledge_history_landmarks (repo, scope, head, plan) VALUES ($1, $2, $3, $4::jsonb)
                ON CONFLICT (repo) DO UPDATE SET scope = $2, head = $3, plan = $4::jsonb`,
              [repo.name, began.repositoryNode, began.head, JSON.stringify(landmarks)]);
            });
            send({ type: 'progress', repository: repo.name, commit: 0, commits: began.commits });
          },
          onPhase: (phase) => { send({ type: 'phase', repository: repo.name, phase: phase.phase, commits: phase.commits, newCommits: phase.newCommits }); },
          // The last commit's code is read first and is published as one: the code is in the graph from here on, so a
          // snapshot is made at once for the server to show it while the history is being read.
          onCommit: async (done, place) => {
            const held = pins.get(repo.name)!;
            if (place.index > base) await pin({ ...held, commit: done.hash, effectiveTime: done.effectiveTime, filledCommits: place.index });
            send({ type: 'progress', repository: repo.name, commit: place.index, commits: place.commits });
            await snapshot(true);
            if (stopping) throw new FillStopped('the fill was stopped');
          },
          onPoint: async () => {
            await snapshot(true);
            if (stopping) throw new FillStopped('the fill was stopped');
          },
        });
        gaps += report.gaps.length + landmarks.diagnostics.length + landmarks.omitted;
      }
      await snapshot(true);
      send({ type: 'fill', state: 'done', gaps });
    } catch (error) {
      if (error instanceof FillStopped) {
        await snapshot(true).catch(() => undefined);
        send({ type: 'fill', state: 'stopped' });
        return 0;
      }
      await snapshot(true).catch(() => undefined);
      send({ type: 'fill', state: 'failed', code: 'fill', message: error instanceof Error ? error.message : String(error) });
      return 0;
    }

    // ---- the index of the Markdown the product already holds ----------------------------------
    // Only one code repository's pages can be tied to a written-at commit and a graph; with several the index of the
    // writer's pages is made by the writer stage's own rule, which refuses them.
    const indexNow = async (): Promise<{ error?: string; unresolved?: string }> => {
      if (repositories.length !== 1) return {};
      const repo = repositories[0]!;
      try {
        const report = await indexWorkerProduct({ owner, store, productFolder, productId: productSlug(start.productName), repository: repo, ...(pins.get(repo.name)?.head === undefined ? {} : { ref: pins.get(repo.name)!.head }) });
        // A kind or a page left out of the index is for the Problems page to list, each with its file and line; it is told here once.
        if (report.findings.length > 0) process.stderr.write(`knowledge index: ${report.findings.length} finding${report.findings.length === 1 ? '' : 's'} left a kind or a page out of the index (the Problems page lists them): ${report.findings.slice(0, 3).map((finding) => `${finding.file}:${finding.line}`).join('; ')}${report.findings.length > 3 ? '; …' : ''}\n`);
        return report.unresolved.length === 0 ? {} : { unresolved: `${report.unresolved.length} grounds or links of the pages name nothing in the graph: ${report.unresolved.slice(0, 3).map((miss) => `${miss.file}:${miss.line} ${miss.target}`).join('; ')}${report.unresolved.length > 3 ? '; …' : ''}` };
      } catch (error) {
        return { error: `the Markdown could not be indexed: ${error instanceof Error ? error.message : String(error)}` };
      }
    };
    const first = await indexNow();
    const firstNote = first.error ?? first.unresolved;
    if (firstNote !== undefined) process.stderr.write(`knowledge index: ${firstNote}\n`);
    // The reader sees the index only in a snapshot made after it: without an agent stage no later snapshot would carry it.
    await snapshot(true).catch(() => undefined);

    // ---- the agent stage --------------------------------------------------------------------
    if (!start.writer) return 0;
    if (repositories.length !== 1) {
      send({ type: 'writer', state: 'failed', code: 'repositories', message: `the writer reads one code repository and the product declares ${repositories.length} (${repositories.map((repo) => repo.name).join(', ')}): nothing was written, so no page is a smaller picture of the product` });
      return 0;
    }
    // What the refresh will touch, and why, is decided from what exists and told before the agent is asked for anything.
    // A run a person limited to one task («Поправить страницы сейчас») gets exactly the pages that task's impact lists.
    let planned: Awaited<ReturnType<typeof planRefresh>> | undefined;
    let briefs: ReadonlyMap<string, EditBrief>;
    let needed: (input: UnitsInput) => UnitsNeeded;
    try {
      if (start.task !== undefined) {
        const run = await planTaskRun({ owner, productFolder, task: start.task });
        briefs = run.briefs;
        needed = neededFromPaths(new Set(briefs.keys()), briefs);
        send({ type: 'plan', plan: run.plan });
      } else {
        const repo = repositories[0]!;
        const head = pins.get(repo.name)?.head ?? (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo.path, encoding: 'utf8' })).stdout.trim();
        planned = await planRefresh({ owner, productFolder, repository: repo, commit: head, language: { from: start.languageFrom ?? null, to: start.language, changed: start.languageChanged } });
        const built = await briefsFor(planned);
        briefs = built;
        needed = neededFrom(planned, built);
        send({ type: 'plan', plan: planned.plan });
      }
    } catch (error) {
      send({ type: 'writer', state: 'failed', code: 'plan', message: `the refresh could not tell which pages need the agent, so it wrote nothing: ${error instanceof Error ? error.message : String(error)}` });
      return 0;
    }
    const answered = new Promise<{ ok: true } | { ok: false; message: string }>((resolve) => { agentAnswer = resolve; });
    send({ type: 'agent-wanted' });
    const agentReady = await answered;
    agentAnswer = undefined;
    if (!agentReady.ok) {
      send({ type: 'writer', state: 'failed', code: 'agent', message: agentReady.message });
      return 0;
    }
    const remote: UnitAgent = {
      run: (request) => new Promise<void>((resolve, reject) => {
        waiting.set(request.id, { resolve, reject, tools: request.tools });
        send({ type: 'unit', id: request.id, prompt: request.prompt, definitions: request.tools.definitions.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
      }),
    };
    const files = fsSink(productFolder);
    const sink = { read: files.read, write: async (relative: string, content: string): Promise<void> => { await files.write(relative, content); send({ type: 'page', path: relative }); } };
    try {
      const repo = repositories[0]!;
      const kinds = readKinds(productFolder);
      const documentSources: DocumentSource[] = kinds.present ? productDocumentPaths(productFolder).filter((path) => listedDocument(kinds.manifest, null, path)).flatMap((path) => {
        const text = readProductDocument(productFolder, path);
        return text === undefined ? [] : [{ repo: null, path, text, origin: join(productFolder, path) }];
      }) : [];
      // The code repository's documents are extracted entities of the wiki too (madarch-m38l.18): a Russian wiki shows each
      // of them in Russian with its original beside it, so the fill reads them as the reader does.
      if (kinds.present) {
        for (const repository of repositories) {
          const commit = pins.get(repository.name)?.commit;
          const at = commit === undefined || commit === '' ? 'HEAD' : commit;
          const all = (await repoDocumentPaths(repository.name, repository.path, at)).filter((path) => listedDocument(kinds.manifest, repository.name, path));
          if (all.length > DOCUMENT_LIMIT) throw new Error(`repos/${repository.name}:1: the repository holds ${all.length} Markdown documents, more than the fill can read (${DOCUMENT_LIMIT}); no smaller set of localized statements was written`);
          const texts = await readRepoDocuments(repository.name, repository.path, at, all);
          for (const path of all) {
            const text = texts.get(path);
            if (typeof text !== 'string') throw new Error(`repos/${repository.name}/${path}:1: the document cannot be read within the document size and byte limits; no smaller set of localized statements was written`);
            documentSources.push({ repo: repository.name, path, text, origin: join(repository.path, path) });
          }
        }
      }
      // The documents are read in the product's store as the wiki reads them: the same stable identities and the same
      // meanings jev and the agent read, so a page the fill writes is a page the wiki shows.
      const storeFolder = dirname(graphPath);
      const identityFile = join(storeFolder, IDENTITIES_FILE);
      const classificationFile = join(storeFolder, CLASSIFICATIONS_FILE);
      const held = kinds.present ? readDocIdentities(identityFile) : { identities: new Map(), findings: [] };
      const classifications = kinds.present && existsSync(classificationFile) ? readClassificationStore(classificationFile) : { answers: new Map(), findings: [] };
      const documentRead = kinds.present
        ? readDocEntities(documentSources, kinds.manifest, { identities: held.identities, ...(classifications.answers.size > 0 ? { classifier: storedClassifier(classifications.answers) } : {}) })
        : { entities: [], findings: [], identities: new Map() };
      if (kinds.present && !sameDocIdentities(held.identities, documentRead.identities)) writeDocIdentities(identityFile, documentRead.identities);
      // Both places of every diagnostic: the identity a reader navigates by, then the file a person opens on this machine.
      for (const finding of [...held.findings, ...classifications.findings, ...documentRead.findings]) {
        send({ type: 'log', line: `${finding.file}:${finding.line}: ${finding.message}${finding.source === undefined ? '' : ` (${finding.source})`}` });
      }
      const documentEntities = documentRead.entities;
      const guidePin = pins.get(repo.name);
      if (guidePin === undefined || guidePin.commit === '' || guidePin.effectiveTime === '') throw new Error('guide preparation requires the completed repository pin');
      const guideSnapshots = createGitSnapshotSource([{ id: repo.name, form: 'code', root: repo.path, commit: guidePin.commit }, guideProductPin(productFolder,[repo.name])]);
      const guides = await createFillGuideWriter({ owner, store, snapshots: guideSnapshots, output: productFolder, scope: guidePin.scope, valid: guidePin.effectiveTime, agent: remote,
        afterWrite: async (path) => { const indexed = await indexNow(); if (indexed.error !== undefined) throw new Error(indexed.error); send({ type: 'page', path }); },
      });
      // The units are kept in the fill's own unit tables under the writer's run name: an interrupted run leaves the
      // finished units published and the next fill of this product writes only what is left (decision 0027;
      // madarch-ztyq.4). The run name is the writer's own: it opens no `fill_run` row, so the fill's progress never
      // counts the same work twice.
      const writerState = fillWriterState(owner, { product: productSlug(start.productName), runId: `writer:${productSlug(start.productName)}:${Date.now().toString(36)}` });
      const report = await runWriter({
        guides,
        state: writerState,
        owner, store, repository: repo.path, ...(pins.get(repo.name)?.head === undefined ? {} : { ref: pins.get(repo.name)!.head }), output: productFolder, productName: start.productName, agent: remote, sink,
        language: start.language, languageChanged: start.languageChanged, documentEntities, repositoryName: repo.name,
        needed,
        resolved: async (used) => { await markResolved(productFolder, used); },
        // Every page written is in the graph's index at once; a failure is told, never hidden.
        afterWrite: async () => { const result = await indexNow(); if (result.error !== undefined) throw new Error(result.error); },
        onUnitStart: (began) => send({ type: 'unit-start', unit: began.unit, path: began.path }),
        onUnit: (outcome) => send({ type: 'unit-outcome', outcome: { unit: outcome.unit, status: outcome.status, writeAttempts: outcome.writeAttempts, calls: outcome.calls, refusals: outcome.refusals.map((r) => ({ line: r.line, rule: r.rule, message: r.message })), domains: [...outcome.domains], questions: [...outcome.questions] } }),
      });
      // A page the reader saw in the preview must be written: a run that silently writes fewer is a failure, not a success.
      if (start.taskPages !== undefined) {
        const written = new Set([...(report.product.status === 'written' ? [PRODUCT_PATH] : []), ...report.domains.filter((unit) => unit.status === 'written').map((unit) => unit.path)]);
        const missing = start.taskPages.filter((page) => !written.has(page));
        if (missing.length > 0) {
          send({ type: 'writer', state: 'failed', code: 'scope', message: `the run wrote fewer pages than the preview showed: ${missing.join(', ')} ${missing.length === 1 ? 'was' : 'were'} not written, so the task is not fixed (the preview showed ${start.taskPages.join(', ')})` });
          return 0;
        }
      }
      const left = report.content.skipped;
      const skipped = left.length === 0 ? '' : ` ${left.length} file${left.length === 1 ? ' was' : 's were'} not stored for the agent to read: ${left.slice(0, 3).map((entry) => `${entry.path === '' ? '(no path)' : entry.path} (${entry.reason})`).join('; ')}${left.length > 3 ? '; …' : ''}.`;
      const stale = report.stale.length === 0 ? '' : ` Pages from an earlier run that this run did not write were left alone: ${report.stale.join(', ')}.`;
      await snapshot(true).catch(() => undefined);
      const indexed = report.indexErrors.length === 0 ? '' : ` The graph index of the written pages failed: ${report.indexErrors.join('; ')}.`;
      const loop = report.loopProblems.length === 0 ? '' : ` Questions and corrections with a problem: ${report.loopProblems.join('; ')}.`;
      const asked = report.questions.length;
      const nothing = report.units === 0 ? ' Nothing needed the agent: no ground changed, no answer or correction was waiting, and the language is the same.' : '';
      if (report.ok) {
        const message = `${nothing}${loop}${stale}${skipped}`.trim();
        send({ type: 'writer', state: 'done', ...(message === '' ? {} : { message }), asked });
      } else {
        send({ type: 'writer', state: 'failed', code: report.indexErrors.length > 0 ? 'index' : 'units', message: `some pages were not written; each unit above says why.${loop}${stale}${skipped}${indexed}`, asked });
      }
    } catch (error) {
      await snapshot(true).catch(() => undefined);
      send({ type: 'writer', state: 'failed', code: 'stopped', message: `the writer stopped: ${error instanceof Error ? error.message : String(error)}` });
    }
    return 0;
  } finally {
    await owner.close().catch(() => undefined);
  }
}

export type { WorkerStart };
