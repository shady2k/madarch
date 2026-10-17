import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseDiscussionMessage, scanDiscussionMarkers } from './discussion-contract.js';
import { mapParagraphSelection, renderedMarkdownParagraphs } from './discussion-selection.js';
import { runGit } from './git.js';
import { parseDocument } from 'yaml';
import { fillStatePaths, persistFillUnit, type FillUnit } from './fill-runtime.js';

export type DiscussionRange = { start: number; end: number; quote: string; before: string; after: string; paragraph: number; from: number; to: number };
export type DiscussionWriteInput = { document: string; range: DiscussionRange; body: string };
export type DiscussionActionInput = { document: string; thread: string; action: 'reply' | 'resolve'; body?: string };
export type DiscussionRecoveryInput = { document: string; thread: string; range: DiscussionRange };
export type DiscussionPageInput = { document: string; body: string };
export type QuestionAnswerInput = { document: string; answer: string; evidence?: string; answerSection: string };
export type DiscussionMessageEntry = { message: string; author: string; time: string; body: string };
export type DiscussionEntry = { message: string; thread: string; document: string; anchor: Record<string, unknown>; author: string; time: string; status: string; body: string; messages?: DiscussionMessageEntry[] };
export type DiscussionReadResult = { ok: true; entries: DiscussionEntry[] } | { ok: false; status: number; message: string };
export type DiscussionWriteResult =
  | { ok: true; thread: string; message: string; document: string; markdown: string }
  | { ok: false; status: number; message: string; retry?: Record<string, unknown> };

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const TOKEN = /^[a-zA-Z0-9_-]+$/;
const locks = new Set<string>();


/** Reads valid v1 messages as threads, preserving message order and detecting lost selection anchors. */
export function readProductDiscussions(product: string, document: string): DiscussionReadResult {
  const root = resolve(product);
  if (!safeDocument(document)) return { ok: false, status: 400, message: `document must be a normalized Markdown page under docs/: ${JSON.stringify(document)}` };
  const target = resolveSafePage(root, document);
  if (typeof target !== 'string') return { ok: false, status: 404, message: target.message };
  const pageMarkdown = readFileSync(target, 'utf8');
  const markerErrors = scanDiscussionMarkers(document, pageMarkdown).errors;
  if (markerErrors.length) return { ok: false, status: 409, message: markerErrors.map((error) => `${error.file}:${error.line}: ${error.message}`).join('; ') };
  const comments = join(root, 'comments');
  if (!existsSync(comments)) return { ok: true, entries: [] };
  const rootStat = lstatSync(comments);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ok: false, status: 409, message: 'the product comments path is not a plain directory' };
  const entries: DiscussionEntry[] = [];
  for (const thread of readdirSync(comments).sort()) {
    if (!ULID.test(thread)) continue;
    const threadPath = join(comments, thread);
    const threadStat = lstatSync(threadPath);
    if (!threadStat.isDirectory() || threadStat.isSymbolicLink()) return { ok: false, status: 409, message: `discussion thread path is not a plain directory: ${thread}` };
    const messages: DiscussionEntry[] = [];
    for (const file of readdirSync(threadPath).sort()) {
      if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}\.md$/.test(file)) continue;
      const full = join(threadPath, file);
      const stat = lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, status: 409, message: `discussion message is not a regular file: comments/${thread}/${file}` };
      const relativePath = `comments/${thread}/${file}`;
      const parsed = parseDiscussionMessage(relativePath, readFileSync(full, 'utf8'));
      if (!parsed.ok) return { ok: false, status: 409, message: parsed.errors.map((error) => `${error.file}:${error.line}: ${error.message}`).join('; ') };
      if (parsed.message.document !== document) continue;
      if (parsed.message.thread !== thread) return { ok: false, status: 409, message: `${relativePath}: the message thread does not match its marker id` };
      messages.push({ message: file.slice(0, -3), thread, document, anchor: parsed.message.anchor as Record<string, unknown>, author: String(parsed.message.author), time: String(parsed.message.time), status: String(parsed.message.status), body: parsed.body });
    }
    if (messages.length === 0) continue;
    messages.sort((a, b) => a.time.localeCompare(b.time) || a.message.localeCompare(b.message));
    const first = messages[0]!;
    const anchor = [...messages].reverse().find((item) => item.anchor.kind === 'selection' || item.anchor.kind === 'page')!.anchor;
    first.anchor = anchor;
    if (anchor.kind === 'selection') {
      const opening = [...pageMarkdown.matchAll(new RegExp(`<!--c:${thread}-->`, 'g'))];
      const closing = [...pageMarkdown.matchAll(new RegExp(`<!--/c:${thread}-->`, 'g'))];
      if (opening.length === 0 && closing.length === 0) {
        // Both markers absent is the valid lost-anchor state; show quote and recovery affordance.
        first.anchor = { ...anchor, lost: true };
      } else if (opening.length !== 1 || closing.length !== 1) {
        return { ok: false, status: 409, message: `${document}: expected exactly one complete marker pair for discussion thread ${thread}` };
      } else {
        const clean = pageMarkdown.replace(/<!--\/?c:[^>]*-->/g, '');
        const cleanOffset = (offset: number): number => pageMarkdown.slice(0, offset).replace(/<!--\/?c:[^>]*-->/g, '').length;
        const from = cleanOffset(opening[0]!.index!); const to = cleanOffset(closing[0]!.index!);
        const before = typeof anchor.before === 'string' ? anchor.before : '';
        const after = typeof anchor.after === 'string' ? anchor.after : '';
        const priorText = before.length === 0 ? '' : [...clean.slice(0, from)].slice(-[...before].length).join('');
        const nextText = after.length === 0 ? '' : [...clean.slice(to)].slice(0, [...after].length).join('');
        if (priorText !== before || nextText !== after) return { ok: false, status: 409, message: `${document}: marker pair ${thread} no longer matches the saved anchor context` };
      }
    } else if (anchor.kind !== 'page') {
      return { ok: false, status: 409, message: `${document}: discussion thread ${thread} has an unsupported anchor kind` };
    }
    const last = messages[messages.length - 1]!;
    entries.push({ ...first, anchor: { ...first.anchor, kind: anchor.kind, resolved: last.status === 'resolved' }, status: last.status, messages: messages.map(({ message, author, time, body }) => ({ message, author, time, body })) } as DiscussionEntry);
  }
  return { ok: true, entries };
}

/** Creates a canonical ULID using the current millisecond and 80 cryptographic random bits. */
export function newDiscussionUlid(now = Date.now(), random = randomBytes(10)): string {
  let time = Math.max(0, Math.min(0xffffffffffff, Math.floor(now)));
  let timePart = '';
  for (let at = 0; at < 10; at++) { timePart = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[time & 31]! + timePart; time = Math.floor(time / 32); }
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  let randomPart = '';
  for (let at = 0; at < 16; at++) { randomPart = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Number(bits & 31n)]! + randomPart; bits >>= 5n; }
  return timePart + randomPart;
}

/** Validates and persists one product-local comment action. Every git and path is rooted at the opened product. */
export function writeProductDiscussion(product: string, input: DiscussionWriteInput, now = new Date(), retryAttempt = 0): DiscussionWriteResult {
  const root = resolve(product);
  if (!safeDocument(input.document)) return { ok: false, status: 400, message: `document must be a normalized Markdown page under docs/: ${JSON.stringify(input.document)}` };
  if (!Number.isInteger(input.range.start) || !Number.isInteger(input.range.end) || input.range.start < 0 || input.range.end <= input.range.start || typeof input.range.quote !== 'string' || input.range.quote.length === 0 || [...input.range.before].length > 32 || [...input.range.after].length > 32)
    return { ok: false, status: 400, message: 'selection must have a nonempty quote, valid source offsets and at most 32 code points of context' };
  if (typeof input.body !== 'string' || input.body.trim() === '' || input.body.length > 20_000) return { ok: false, status: 400, message: 'message body must contain 1–20000 characters' };
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return { ok: false, status: 400, message: `product folder is not a plain directory: ${JSON.stringify(root)}` };
  const lock = root;
  if (locks.has(lock)) return { ok: false, status: 409, message: 'another discussion write is in progress for this product; retry the draft' };
  locks.add(lock);
  let tempPage: string | undefined;
  let tempMessage: string | undefined;
  let committed = false;
  let parent = '';
  let commit = '';
  let newPaths: string[] = [];
  let pageChanged = false;
  let originalMarkdown = '';
  let editedMarkdown = '';
  let pagePath = '';
  let stagedPaths: string[] = [];
  let createdDirectories: string[] = [];
  let pushRejected = false;
  let thread = '';
  let message = '';
  let responseMarkdown = '';
  try {
    const path = resolveSafePage(root, input.document);
    if (typeof path !== 'string') return { ok: false, status: 400, message: path.message };
    if (!ownRepo(root)) return { ok: false, status: 409, message: `the selected product is not its own git repository: ${JSON.stringify(root)}` };
    const clean = cleanTree(root);
    if (!clean.ok) return { ok: false, status: 409, message: clean.message };
    const pageBefore = readFileSync(path, 'utf8');
    pagePath = path; originalMarkdown = pageBefore;
    const remapped = mapParagraphSelection(pageBefore, input.range.from, input.range.to, input.range.paragraph);
    if (!remapped.ok || remapped.range.start !== input.range.start || remapped.range.end !== input.range.end || remapped.range.quote !== input.range.quote || remapped.range.before !== input.range.before || remapped.range.after !== input.range.after)
      return { ok: false, status: 409, message: 'the selected source range no longer matches its rendered quote and context; reload the page and select again', retry: { ...input, document: input.document } };
    if (input.range.end > pageBefore.length) return { ok: false, status: 409, message: 'the selected source range is stale; reload the page and select again', retry: { ...input, document: input.document } };
    const original = pageBefore.slice(input.range.start, input.range.end);
    // The complete source range may include Markdown delimiters; the quote is separately preserved as rendered text.
    if (original.length === 0) return { ok: false, status: 400, message: 'the selected source range is empty' };
    thread = newDiscussionUlid(now.valueOf());
    message = newDiscussionUlid(now.valueOf());
    const source = runGit(root, ['rev-parse', 'HEAD']);
    if (!source.ok || !/^[0-9a-f]{40}$/.test(source.output)) return { ok: false, status: 409, message: `the product repository has no readable HEAD: ${source.output}` };
    const author = runGit(root, ['config', '--get', 'user.name']);
    if (!author.ok || author.output.trim() === '') return { ok: false, status: 409, message: 'the product git author name is not configured; configure user.name and retry the draft' };
    const at = now.toISOString();
    const content = `${pageBefore.slice(0, input.range.start)}<!--c:${thread}-->${pageBefore.slice(input.range.start, input.range.end)}<!--/c:${thread}-->${pageBefore.slice(input.range.end)}`;
    editedMarkdown = content;
    responseMarkdown = content;
    const markerErrors = scanDiscussionMarkers(input.document, content).errors;
    if (markerErrors.length) return { ok: false, status: 400, message: markerErrors.map((error) => `${error.file}:${error.line}: ${error.message}`).join('; ') };
    const messagePath = `comments/${thread}/${message}.md`;
    const messageText = ['---', 'contract: 1', `author: ${yaml(inputAuthor(author.output))}`, `time: ${at}`, `thread: ${thread}`, 'anchor:', '  kind: selection', `  quote: ${yaml(input.range.quote)}`, `  before: ${yaml(input.range.before)}`, `  after: ${yaml(input.range.after)}`, `document: ${yaml(input.document)}`, `sourceCommit: ${source.output}`, 'status: open', '---', '', input.body, ''].join('\n');
    const parsed = parseDiscussionMessage(messagePath, messageText);
    if (!parsed.ok) return { ok: false, status: 400, message: parsed.errors.map((error) => `${error.file}:${error.line}: ${error.message}`).join('; ') };
    const absMessage = resolve(root, ...messagePath.split('/'));
    if (existsSync(absMessage)) return { ok: false, status: 409, message: `the generated discussion message path already exists: ${messagePath}` };
    // Recheck source and cleanliness immediately before the two atomic replacements.
    const checked = resolveSafePage(root, input.document);
    if (typeof checked !== 'string' || checked !== path || readFileSync(path, 'utf8') !== pageBefore) return { ok: false, status: 409, message: 'the selected document changed while the comment was being prepared; retry the draft' };
    const reClean = cleanTree(root);
    if (!reClean.ok) return { ok: false, status: 409, message: reClean.message };
    createdDirectories = ensureSafeDirectory(root, dirname(absMessage));
    tempPage = `${path}.madarch-${newDiscussionUlid(now.valueOf())}.tmp`;
    tempMessage = `${absMessage}.madarch-${newDiscussionUlid(now.valueOf())}.tmp`;
    writeFileSync(tempPage, content, { flag: 'wx', mode: 0o600 });
    writeFileSync(tempMessage, messageText, { flag: 'wx', mode: 0o600 });
    renameSync(tempPage, path); tempPage = undefined; pageChanged = true;
    renameSync(tempMessage, absMessage); tempMessage = undefined;
    newPaths = [absMessage];
    stagedPaths = [input.document, messagePath];
    const add = runGit(root, ['add', '--', input.document, messagePath]);
    if (!add.ok) throw new Error(`git add refused the discussion files: ${add.output}`);
    const cached = runGit(root, ['diff', '--cached', '--name-only', '--no-renames']);
    if (!cached.ok || cached.output.split('\n').filter(Boolean).sort().join('\n') !== [input.document, messagePath].sort().join('\n')) throw new Error(`the staged paths are not exactly the discussion document and message: ${cached.output}`);
    parent = source.output;
    const commitResult = runGit(root, ['commit', '--quiet', '-m', 'Add product discussion comment']);
    if (!commitResult.ok) throw new Error(`git commit refused the discussion: ${commitResult.output}`);
    committed = true;
    const head = runGit(root, ['rev-parse', 'HEAD']);
    if (!head.ok) throw new Error(`cannot read discussion commit: ${head.output}`);
    commit = head.output;
    const parentResult = runGit(root, ['rev-parse', `${commit}^`]);
    if (!parentResult.ok) throw new Error(`cannot read discussion commit parent: ${parentResult.output}`);
    parent = parentResult.output;
    const pushed = runGit(root, ['push', 'origin', 'HEAD']);
    if (!pushed.ok) { pushRejected = true; throw new Error(`the comment was committed locally but the push was rejected: ${pushed.output}`); }
    return { ok: true, thread, message, document: input.document, markdown: content };
  } catch (error) {
    let rolledBack = false;
    if (committed && commit !== '' && parent !== '') {
      const current = runGit(root, ['rev-parse', 'HEAD']);
      const status = runGit(root, ['status', '--porcelain', '--untracked-files=all']);
      if (current.ok && current.output === commit && status.ok && status.output === '') {
        const reset = runGit(root, ['reset', '--hard', parent]);
        rolledBack = reset.ok;
        if (reset.ok) for (const path of newPaths) rmSync(path, { force: true });
      }
    } else {
      if (stagedPaths.length > 0) runGit(root, ['reset', '--', ...stagedPaths]);
      for (const path of newPaths) rmSync(path, { force: true });
      if (pageChanged) {
        const stillOurs = resolveSafePage(root, input.document);
        if (typeof stillOurs === 'string' && readFileSync(stillOurs, 'utf8') === editedMarkdown) {
          const restore = `${stillOurs}.madarch-${newDiscussionUlid()}.tmp`;
          writeFileSync(restore, originalMarkdown, { flag: 'wx', mode: 0o600 });
          renameSync(restore, stillOurs);
        }
      }
    }
    if (pushRejected && retryAttempt === 0 && rolledBack) {
      const fetched = runGit(root, ['fetch', 'origin']);
      const branch = runGit(root, ['symbolic-ref', '--short', 'HEAD']);
      const remoteRef = branch.ok ? `refs/remotes/origin/${branch.output}` : '';
      const remoteTip = remoteRef === '' ? { ok: false as const, output: '' } : runGit(root, ['rev-parse', '--verify', remoteRef]);
      const containsOurCommit = fetched.ok && remoteTip.ok && runGit(root, ['merge-base', '--is-ancestor', commit, remoteRef]).ok;
      const merged = fetched.ok && remoteTip.ok ? runGit(root, ['merge', '--ff-only', remoteRef]) : { ok: false as const, output: 'origin branch is unavailable' };
      if (containsOurCommit && merged.ok) return { ok: true, thread, message, document: input.document, markdown: responseMarkdown };
      const freshStatus = cleanTree(root);
      const page = resolveSafePage(root, input.document);
      if (merged.ok && freshStatus.ok && typeof page === 'string') {
        const currentMarkdown = readFileSync(page, 'utf8');
        const mapped = mapParagraphSelection(currentMarkdown, input.range.from, input.range.to, input.range.paragraph);
        if (mapped.ok && mapped.range.start === input.range.start && mapped.range.end === input.range.end && mapped.range.quote === input.range.quote && mapped.range.before === input.range.before && mapped.range.after === input.range.after) {
          for (const directory of [...createdDirectories].reverse()) { try { rmdirSync(directory); } catch { /* absent or nonempty */ } }
          locks.delete(lock);
          return writeProductDiscussion(root, input, now, retryAttempt + 1);
        }
      }
    }
    const outcome = pushRejected ? 'the push outcome could not be confirmed; check the remote before retrying' : `not sent: ${(error as Error).message}`;
    return { ok: false, status: 409, message: outcome, retry: { ...input, document: input.document } };
  } finally {
    for (const temporary of [tempPage, tempMessage]) if (temporary !== undefined) rmSync(temporary, { force: true });
    for (const directory of [...createdDirectories].reverse()) { try { rmdirSync(directory); } catch { /* nonempty or already removed */ } }
    locks.delete(lock);
  }
}

/** Appends one reply or resolution message without rewriting prior messages or the page. */
export function writeProductDiscussionAction(product: string, input: DiscussionActionInput, now = new Date()): DiscussionWriteResult {
  const root = resolve(product);
  if (!safeDocument(input.document) || !ULID.test(input.thread)) return { ok: false, status: 400, message: 'discussion action needs a normalized document path and thread ULID' };
  if (input.action !== 'reply' && input.action !== 'resolve') return { ok: false, status: 400, message: 'discussion action must be reply or resolve' };
  if (input.action === 'reply' && (typeof input.body !== 'string' || input.body.trim() === '' || input.body.length > 20_000)) return { ok: false, status: 400, message: 'reply body must contain 1–20000 characters' };
  if (locks.has(root)) return { ok: false, status: 409, message: 'another discussion write is in progress for this product; retry the action' };
  locks.add(root);
  const created: string[] = [];
  let file = ''; let parent = ''; let commitHash = ''; let committed = false;
  try {
    if (!ownRepo(root)) return { ok: false, status: 409, message: `the selected product is not its own git repository: ${JSON.stringify(root)}` };
    const clean = cleanTree(root); if (!clean.ok) return { ok: false, status: 409, message: clean.message };
    const read = readProductDiscussions(root, input.document); if (!read.ok) return { ok: false, status: read.status, message: read.message };
    const thread = read.entries.find((entry) => entry.thread === input.thread);
    if (thread === undefined) return { ok: false, status: 404, message: `discussion thread does not exist: ${input.thread}` };
    if (input.action === 'reply' && thread.status === 'resolved') return { ok: false, status: 409, message: 'a resolved discussion cannot receive replies' };
    const head = runGit(root, ['rev-parse', 'HEAD']);
    const author = runGit(root, ['config', '--get', 'user.name']);
    if (!head.ok || !/^[0-9a-f]{40}$/.test(head.output) || !author.ok || author.output.trim() === '') return { ok: false, status: 409, message: 'the product git HEAD or author is not configured' };
    parent = head.output;
    const lastTime = Math.max(...(thread.messages ?? []).map((item) => Date.parse(item.time)).filter(Number.isFinite), 0);
    const actionTime = new Date(Math.max(now.valueOf(), lastTime + 1));
    const message = newDiscussionUlid(actionTime.valueOf());
    const text = ['---', 'contract: 1', `author: ${yaml(inputAuthor(author.output))}`, `time: ${actionTime.toISOString()}`, `thread: ${input.thread}`, 'anchor:', ...anchorLines(thread.anchor), `document: ${yaml(input.document)}`, `sourceCommit: ${head.output}`, `status: ${input.action === 'resolve' ? 'resolved' : thread.status}`, '---', '', input.action === 'reply' ? input.body! : ''].join('\n') + '\n';
    const messagePath = `comments/${input.thread}/${message}.md`;
    const parsed = parseDiscussionMessage(messagePath, text);
    if (!parsed.ok) return { ok: false, status: 400, message: parsed.errors.map((error) => `${error.file}:${error.line}: ${error.message}`).join('; ') };
    const abs = resolve(root, ...messagePath.split('/'));
    if (existsSync(abs)) return { ok: false, status: 409, message: `generated discussion message already exists: ${messagePath}` };
    created.push(...ensureSafeDirectory(root, dirname(abs)));
    writeFileSync(abs, text, { flag: 'wx', mode: 0o600 });
    file = abs;
    const add = runGit(root, ['add', '--', messagePath]);
    const staged = runGit(root, ['diff', '--cached', '--name-only', '--no-renames']);
    if (!add.ok || !staged.ok || staged.output.trim() !== messagePath) throw new Error(`could not stage exactly ${messagePath}: ${staged.output}`);
    const commit = runGit(root, ['commit', '--quiet', '-m', input.action === 'resolve' ? 'Resolve product discussion' : 'Reply to product discussion']);
    if (!commit.ok) throw new Error(`git commit failed: ${commit.output}`);
    const newHead = runGit(root, ['rev-parse', 'HEAD']); if (!newHead.ok) throw new Error('cannot read discussion action commit');
    committed = true; commitHash = newHead.output;
    const push = runGit(root, ['push', 'origin', 'HEAD']);
    if (!push.ok) throw new Error(`push failed: ${push.output}`);
    return { ok: true, thread: input.thread, message, document: input.document, markdown: text };
  } catch (error) {
    if (committed && commitHash !== '' && parent !== '') {
      const head = runGit(root, ['rev-parse', 'HEAD']); const status = runGit(root, ['status', '--porcelain', '--untracked-files=all']);
      if (head.ok && head.output === commitHash && status.ok && status.output === '') runGit(root, ['reset', '--hard', parent]);
    } else if (file !== '') {
      runGit(root, ['reset', '--', file.slice(root.length + 1)]); rmSync(file, { force: true });
    }
    return { ok: false, status: 409, message: `not sent: ${(error as Error).message}`, retry: { document: input.document, thread: input.thread, action: input.action, ...(input.body === undefined ? {} : { body: input.body }) } };
  } finally {
    for (const directory of created.reverse()) { try { rmdirSync(directory); } catch { /* nonempty */ } }
    locks.delete(root);
  }
}

/** Restores a lost selection's paired markers at a validated reader-selected range. */
export function restoreProductDiscussionAnchor(product: string, input: DiscussionRecoveryInput): DiscussionWriteResult {
  const root = resolve(product);
  if (!safeDocument(input.document) || !ULID.test(input.thread)) return { ok: false, status: 400, message: 'anchor recovery needs a normalized document and thread ULID' };
  if (locks.has(root)) return { ok: false, status: 409, message: 'another discussion write is in progress for this product; retry anchor recovery' };
  locks.add(root);
  let pagePath = ''; let original = ''; let edited = ''; let created = false; let committed = false; let parent = ''; let commit = '';
  try {
    if (!ownRepo(root)) return { ok: false, status: 409, message: `the selected product is not its own git repository: ${JSON.stringify(root)}` };
    const clean = cleanTree(root); if (!clean.ok) return { ok: false, status: 409, message: clean.message };
    const read = readProductDiscussions(root, input.document); if (!read.ok) return { ok: false, status: read.status, message: read.message };
    const thread = read.entries.find((entry) => entry.thread === input.thread);
    if (thread === undefined || thread.anchor.kind !== 'selection' || thread.anchor.lost !== true) return { ok: false, status: 409, message: 'only a lost selection anchor can be recovered' };
    const held = resolveSafePage(root, input.document); if (typeof held !== 'string') return { ok: false, status: 404, message: held.message };
    original = readFileSync(held, 'utf8');
    const mapped = mapParagraphSelection(original, input.range.from, input.range.to, input.range.paragraph);
    if (!mapped.ok || mapped.range.start !== input.range.start || mapped.range.end !== input.range.end || mapped.range.quote !== input.range.quote || mapped.range.before !== input.range.before || mapped.range.after !== input.range.after || input.range.quote !== thread.anchor.quote || input.range.before !== thread.anchor.before || input.range.after !== thread.anchor.after)
      return { ok: false, status: 409, message: 'the chosen range must match the saved quote and context; select that exact range again' };
    const currentHead = runGit(root, ['rev-parse', 'HEAD']); if (!currentHead.ok) return { ok: false, status: 409, message: `cannot read product HEAD: ${currentHead.output}` };
    const content = `${original.slice(0, input.range.start)}<!--c:${input.thread}-->${original.slice(input.range.start, input.range.end)}<!--/c:${input.thread}-->${original.slice(input.range.end)}`;
    const markers = scanDiscussionMarkers(input.document, content).errors;
    if (markers.length) return { ok: false, status: 409, message: markers.map((e) => `${e.file}:${e.line}: ${e.message}`).join('; ') };
    const pageTemp = `${held}.madarch-${newDiscussionUlid()}.tmp`;
    writeFileSync(pageTemp, content, { flag: 'wx', mode: 0o600 });
    if (readFileSync(held, 'utf8') !== original) { rmSync(pageTemp, { force: true }); return { ok: false, status: 409, message: 'the page changed during anchor recovery; reload and try again' }; }
    renameSync(pageTemp, held); created = true; pagePath = held; edited = content;
    const staged = runGit(root, ['add', '--', input.document]);
    const names = runGit(root, ['diff', '--cached', '--name-only', '--no-renames']);
    if (!staged.ok || !names.ok || names.output.trim() !== input.document) throw new Error(`could not stage only ${input.document}`);
    parent = currentHead.output;
    const result = runGit(root, ['commit', '--quiet', '-m', 'Restore product discussion anchor']);
    if (!result.ok) throw new Error(`git commit failed: ${result.output}`);
    committed = true; const newHead = runGit(root, ['rev-parse', 'HEAD']); if (!newHead.ok) throw new Error('cannot read anchor recovery commit'); commit = newHead.output;
    const pushed = runGit(root, ['push', 'origin', 'HEAD']); if (!pushed.ok) throw new Error(`push failed: ${pushed.output}`);
    return { ok: true, thread: input.thread, message: thread.message, document: input.document, markdown: content };
  } catch (error) {
    if (committed && commit !== '' && parent !== '') {
      const head = runGit(root, ['rev-parse', 'HEAD']); const status = runGit(root, ['status', '--porcelain', '--untracked-files=all']);
      if (head.ok && head.output === commit && status.ok && status.output === '') runGit(root, ['reset', '--hard', parent]);
    } else {
      runGit(root, ['reset', '--', input.document]);
      if (created && pagePath !== '' && readFileSync(pagePath, 'utf8') === edited) {
        const temp = `${pagePath}.madarch-${newDiscussionUlid()}.tmp`; writeFileSync(temp, original, { flag: 'wx', mode: 0o600 }); renameSync(temp, pagePath);
      }
    }
    return { ok: false, status: 409, message: `not sent: ${(error as Error).message}`, retry: { document: input.document, thread: input.thread, action: 'recover', range: input.range } };
  } finally { locks.delete(root); }
}

/** Answers an open question by editing its Markdown through the same guarded product-git path as page discussions. */
export async function answerProductQuestion(product: string, input: QuestionAnswerInput): Promise<DiscussionWriteResult> {
  const root = resolve(product);
  if (!safeDocument(input.document) || typeof input.answer !== 'string' || input.answer.trim() === '' || input.answer.length > 20_000 || !/^[A-Za-z][A-Za-z0-9 _-]*$/.test(input.answerSection)) return { ok: false, status: 400, message: 'question answer needs a normalized document, a 1–20000 character Markdown answer, and a configured answer section' };
  if (locks.has(root)) return { ok: false, status: 409, message: 'another product write is in progress; retry the answer' };
  locks.add(root);
  let file = ''; let original = ''; let edited = ''; let committed = false; let parent = ''; let commitHash = '';
  try {
    if (!ownRepo(root)) return { ok: false, status: 409, message: `the selected product is not its own git repository: ${JSON.stringify(root)}` };
    const clean = cleanTree(root); if (!clean.ok) return { ok: false, status: 409, message: clean.message };
    const absolute = resolveSafePage(root, input.document); if (typeof absolute !== 'string') return { ok: false, status: 404, message: absolute.message };
    original = readFileSync(absolute, 'utf8');
    const lines = original.split('\n');
    const heading = `## ${input.answerSection}`;
    const headingIndex = lines.findIndex((line) => line.trim() === heading);
    if (headingIndex < 0) return { ok: false, status: 400, message: `question document has no configured ${heading} section` };
    let end = headingIndex + 1;
    while (end < lines.length && !/^ {0,3}##\s/.test(lines[end]!)) end++;
    const body = lines.slice(headingIndex + 1, end);
    if (body.some((line) => line.trim() !== '')) return { ok: false, status: 409, message: 'this question already has an answer; reload before editing' };
    lines.splice(headingIndex + 1, end - headingIndex - 1, '', input.answer.trim(), '');
    edited = lines.join('\n');
    if (readFileSync(absolute, 'utf8') !== original) return { ok: false, status: 409, message: 'the question changed while the answer was prepared; reload and retry' };
    parent = runGit(root, ['rev-parse', 'HEAD']).output;
    const author = runGit(root, ['config', '--get', 'user.name']);
    if (!/^[0-9a-f]{40}$/.test(parent) || !author.ok || author.output.trim() === '') return { ok: false, status: 409, message: 'the product git HEAD or author is not configured' };
    const temporary = `${absolute}.madarch-${newDiscussionUlid()}.tmp`;
    writeFileSync(temporary, edited, { flag: 'wx', mode: 0o600 }); renameSync(temporary, absolute);
    file = input.document;
    const added = runGit(root, ['add', '--', file]); const staged = runGit(root, ['diff', '--cached', '--name-only', '--no-renames']);
    if (!added.ok || !staged.ok || staged.output.trim() !== file) throw new Error(`could not stage exactly ${file}: ${staged.output}`);
    await invalidateDependentFillUnits(root, input.document);
    const result = runGit(root, ['commit', '--quiet', '-m', 'Answer product question']); if (!result.ok) throw new Error(result.output);
    const head = runGit(root, ['rev-parse', 'HEAD']); if (!head.ok) throw new Error('cannot read answer commit');
    committed = true; commitHash = head.output;
    const pushed = runGit(root, ['push', 'origin', 'HEAD']); if (!pushed.ok) throw new Error(`push failed: ${pushed.output}`);
    return { ok: true, thread: '', message: '', document: input.document, markdown: edited };
  } catch (error) {
    if (committed && commitHash !== '' && parent !== '') {
      const head = runGit(root, ['rev-parse', 'HEAD']); const status = runGit(root, ['status', '--porcelain', '--untracked-files=all']);
      if (head.ok && head.output === commitHash && status.ok && status.output === '') runGit(root, ['reset', '--hard', parent]);
    } else if (file !== '') {
      runGit(root, ['reset', '--', file]);
      const current = resolve(root, ...file.split('/'));
      if (readFileSync(current, 'utf8') === edited) { const temp = `${current}.madarch-${newDiscussionUlid()}.tmp`; writeFileSync(temp, original, { flag: 'wx', mode: 0o600 }); renameSync(temp, current); }
    }
    return { ok: false, status: 409, message: `not sent: ${(error as Error).message}`, retry: { document: input.document, answer: input.answer } };
  } finally { locks.delete(root); }
}

/** Read dependency ids from the design's YAML front matter, with legacy flat fields accepted. */
function questionDependencies(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end > 0) {
      const parsed = parseDocument(lines.slice(1, end).join('\n'));
      if (parsed.errors.length > 0) throw new Error(`question front matter could not be read: ${parsed.errors[0]!.message}`);
      const metadata = parsed.toJS() as unknown;
      if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('question front matter must be a YAML mapping');
      const depends = (metadata as Record<string, unknown>)['depends-on'];
      if (Array.isArray(depends) && depends.every((item) => typeof item === 'string')) return depends as string[];
      if (typeof depends === 'string') return depends.split(',').map((value) => value.trim()).filter(Boolean);
      if (depends !== undefined) throw new Error('question depends-on must be a string or list of strings');
    }
  }
  return markdown.match(/^(?:depends-on|Depends on): (.*)$/m)?.[1]?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
}

/** Map claim records embedded in unit outputs back to the synthesis unit that consumes them. */
function claimConsumerUnits(product: string, units: ReadonlyMap<string, FillUnit>): Map<string, Set<string>> {
  const consumers = new Map<string, Set<string>>();
  for (const unit of units.values()) for (const output of unit.outputPaths) {
    const file = resolve(product, output);
    if (!file.startsWith(`${resolve(product)}${sep}`) || !file.endsWith('.json') || !existsSync(file)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown; }
    catch (error) { throw new Error(`${file}: cannot read claim references for question invalidation: ${(error as Error).message}`); }
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      if (value === null || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (typeof record.id === 'string' && /^clm-[A-Za-z0-9_-]+$/.test(record.id)) {
        const found = consumers.get(record.id) ?? new Set<string>(); found.add(unit.id); consumers.set(record.id, found);
      }
      for (const child of Object.values(record)) visit(child);
    };
    visit(parsed);
  }
  return consumers;
}

/** Mark units that declare the answered question document as an input stale; they rerun on next resume. */
async function invalidateDependentFillUnits(product: string, document: string): Promise<void> {
  const paths = fillStatePaths(product);
  if (!existsSync(paths.units)) return;
  const questionText = readFileSync(resolve(product, ...document.split('/')), 'utf8');
  const questionId = questionText.match(/^# ([A-Za-z][A-Za-z0-9_-]*)\s*(?:—|:)/m)?.[1];
  const mentioned = questionDependencies(questionText);
  const invalidated = new Set([document, ...(questionId === undefined ? [] : [questionId]), ...mentioned]);
  const units = new Map<string, FillUnit>();
  for (const name of readdirSync(paths.units).filter((entry) => entry.endsWith('.json')).sort()) {
    const unitPath = join(paths.units, name);
    try { units.set(name.slice(0, -5), JSON.parse(readFileSync(unitPath, 'utf8')) as FillUnit); }
    catch (error) { throw new Error(`${unitPath}: cannot invalidate question-dependent fill unit: ${(error as Error).message}`); }
  }
  const claimConsumers = claimConsumerUnits(product, units);
  for (const id of mentioned) for (const consumer of claimConsumers.get(id) ?? []) invalidated.add(consumer);
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of units.values()) {
      if (invalidated.has(unit.id) || !(unit.dependencies ?? []).some((dependency) => invalidated.has(dependency))) continue;
      invalidated.add(unit.id); changed = true;
    }
  }
  for (const unit of units.values()) {
    const inputNamesQuestion = Object.keys(unit.inputHashes).some((key) => key === document || key === questionId || mentioned.includes(key));
    if ((invalidated.has(unit.id) || inputNamesQuestion) && (unit.status === 'complete' || unit.status === 'running')) await persistFillUnit(product, { ...unit, status: 'stale', error: undefined, finishedAt: undefined });
  }
}

/** Creates a page-level thread as one message-only git action. */
export function writeProductPageDiscussion(product: string, input: DiscussionPageInput, now = new Date()): DiscussionWriteResult {
  const root = resolve(product);
  if (!safeDocument(input.document) || typeof input.body !== 'string' || input.body.trim() === '' || input.body.length > 20_000) return { ok: false, status: 400, message: 'page discussion needs a valid document and a 1–20000 character message' };
  if (locks.has(root)) return { ok: false, status: 409, message: 'another discussion write is in progress for this product; retry the action' };
  locks.add(root);
  let path = ''; let parent = ''; let commitHash = ''; let committed = false;
  try {
    if (!ownRepo(root)) return { ok: false, status: 409, message: `the selected product is not its own git repository: ${JSON.stringify(root)}` };
    const clean = cleanTree(root); if (!clean.ok) return { ok: false, status: 409, message: clean.message };
    const held = resolveSafePage(root, input.document); if (typeof held !== 'string') return { ok: false, status: 404, message: held.message };
    const head = runGit(root, ['rev-parse', 'HEAD']); const author = runGit(root, ['config', '--get', 'user.name']);
    if (!head.ok || !author.ok || author.output.trim() === '') return { ok: false, status: 409, message: 'the product git HEAD or author is not configured' };
    const thread = newDiscussionUlid(now.valueOf()); const message = newDiscussionUlid(now.valueOf());
    parent = head.output;
    const messagePath = `comments/${thread}/${message}.md`;
    const text = ['---', 'contract: 1', `author: ${yaml(inputAuthor(author.output))}`, `time: ${now.toISOString()}`, `thread: ${thread}`, 'anchor:', '  kind: page', `document: ${yaml(input.document)}`, `sourceCommit: ${head.output}`, 'status: open', '---', '', input.body, ''].join('\n');
    const parsed = parseDiscussionMessage(messagePath, text); if (!parsed.ok) return { ok: false, status: 400, message: parsed.errors.map((e) => `${e.file}:${e.line}: ${e.message}`).join('; ') };
    const absolute = resolve(root, ...messagePath.split('/')); const dirs = ensureSafeDirectory(root, dirname(absolute));
    try {
      writeFileSync(absolute, text, { flag: 'wx', mode: 0o600 }); path = absolute;
      const added = runGit(root, ['add', '--', messagePath]); const staged = runGit(root, ['diff', '--cached', '--name-only', '--no-renames']);
      if (!added.ok || !staged.ok || staged.output.trim() !== messagePath) throw new Error(`could not stage exactly ${messagePath}`);
      const commitResult = runGit(root, ['commit', '--quiet', '-m', 'Add page discussion']); if (!commitResult.ok) throw new Error(commitResult.output);
      const newHead = runGit(root, ['rev-parse', 'HEAD']); if (!newHead.ok) throw new Error('cannot read page discussion commit'); committed = true; commitHash = newHead.output;
      const pushed = runGit(root, ['push', 'origin', 'HEAD']); if (!pushed.ok) throw new Error(pushed.output);
      return { ok: true, thread, message, document: input.document, markdown: text };
    } catch (error) {
      if (committed && commitHash !== '' && parent !== '') { const current = runGit(root, ['rev-parse', 'HEAD']); const status = runGit(root, ['status', '--porcelain', '--untracked-files=all']); if (current.ok && current.output === commitHash && status.ok && status.output === '') runGit(root, ['reset', '--hard', parent]); }
      else { rmSync(absolute, { force: true }); runGit(root, ['reset', '--', messagePath]); }
      return { ok: false, status: 409, message: `not sent: ${(error as Error).message}`, retry: { document: input.document, action: 'page', body: input.body } };
    } finally { for (const d of dirs.reverse()) { try { rmdirSync(d); } catch { /* nonempty */ } } }
  } finally { locks.delete(root); }
}

function anchorLines(anchor: Record<string, unknown>): string[] {
  if (anchor.kind === 'selection') return ['  kind: selection', `  quote: ${yaml(String(anchor.quote ?? ''))}`, `  before: ${yaml(String(anchor.before ?? ''))}`, `  after: ${yaml(String(anchor.after ?? ''))}`];
  return ['  kind: page'];
}

function ownRepo(root: string): boolean { const top = runGit(root, ['rev-parse', '--show-toplevel']); return top.ok && resolve(top.output) === root; }
function safeDocument(path: string): boolean {
  return typeof path === 'string' && /^docs\/(?:[^/]+\/)*[^/]+\.md$/.test(path) && !path.split('/').some((part) => part === '.' || part === '..' || part === '');
}
function resolveSafePage(root: string, path: string): string | { message: string } {
  if (!safeDocument(path)) return { message: `document path is not allowed: ${JSON.stringify(path)}` };
  const absolute = resolve(root, ...path.split('/'));
  const rel = relative(root, absolute);
  if (rel.startsWith(`..${sep}`) || rel === '..' || rel === '') return { message: `document path escapes the product: ${JSON.stringify(path)}` };
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch { return { message: `document path is not a held regular Markdown file: ${JSON.stringify(path)}` }; }
    if (stat.isSymbolicLink()) return { message: `document path traverses a symlink and is refused: ${JSON.stringify(path)}` };
    if (current === absolute ? !stat.isFile() : !stat.isDirectory()) return { message: `document path has a non-directory component: ${JSON.stringify(path)}` };
  }
  return absolute;
}
function cleanTree(root: string): { ok: true } | { ok: false; message: string } {
  if (!runGit(root, ['rev-parse', '--show-toplevel']).ok) return { ok: false, message: `the selected product is not its own git repository: ${JSON.stringify(root)}` };
  const status = runGit(root, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']);
  if (!status.ok) return { ok: false, message: `cannot inspect the product worktree: ${status.output}` };
  if (status.output !== '') return { ok: false, message: `the product repository has changes; commit or discard them before commenting: ${status.output}` };
  const remote = runGit(root, ['remote', 'get-url', 'origin']);
  if (!remote.ok || remote.output.trim() === '') return { ok: false, message: 'the product repository has no origin remote configured; the comment was not sent' };
  return { ok: true };
}
function ensureSafeDirectory(root: string, directory: string): string[] {
  const created: string[] = [];
  const rel = relative(root, directory);
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) { mkdirSync(current, { mode: 0o700 }); created.push(current); }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`message directory is not a plain directory: ${current}`);
  }
  return created;
}
function yaml(value: string): string { return JSON.stringify(value); }
function inputAuthor(value: string): string { return value.trim(); }
