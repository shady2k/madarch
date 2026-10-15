import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseDiscussionMessage, scanDiscussionMarkers } from './discussion-contract.js';
import { mapParagraphSelection, renderedMarkdownParagraphs } from '../../wiki/app/src/discussion-selection.js';
import { runGit } from './git.js';

export type DiscussionWriteInput = {
  document: string;
  range: { start: number; end: number; quote: string; before: string; after: string; paragraph: number; from: number; to: number };
  body: string;
};
export type DiscussionEntry = { message: string; thread: string; document: string; anchor: Record<string, unknown>; author: string; time: string; status: string; body: string };
export type DiscussionReadResult = { ok: true; entries: DiscussionEntry[] } | { ok: false; status: number; message: string };
export type DiscussionWriteResult =
  | { ok: true; thread: string; message: string; document: string; markdown: string }
  | { ok: false; status: number; message: string; retry?: { document: string; range: DiscussionWriteInput['range']; body: string } };

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const TOKEN = /^[a-zA-Z0-9_-]+$/;
const locks = new Set<string>();


/** Reads only valid v1 messages anchored to the requested held page. */
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
      const opening = [...pageMarkdown.matchAll(new RegExp(`<!--c:${thread}-->`, 'g'))];
      const closing = [...pageMarkdown.matchAll(new RegExp(`<!--/c:${thread}-->`, 'g'))];
      if (opening.length !== 1 || closing.length !== 1) return { ok: false, status: 409, message: `${document}: expected exactly one marker pair for discussion thread ${thread}` };
      const anchor = parsed.message.anchor as Record<string, unknown>;
      const quote = typeof anchor.quote === 'string' ? anchor.quote : '';
      const before = typeof anchor.before === 'string' ? anchor.before : '';
      const after = typeof anchor.after === 'string' ? anchor.after : '';
      const cleanOffset = (offset: number): number => pageMarkdown.slice(0, offset).replace(/<!--\/?c:[^>]*-->/g, '').length;
      const sourceStart = cleanOffset(opening[0]!.index!);
      const sourceEnd = cleanOffset(closing[0]!.index!);
      const paragraphs = renderedMarkdownParagraphs(pageMarkdown.replace(/<!--\/?c:[^>]*-->/g, ''));
      let matches = 0;
      for (let paragraph = 0; paragraph < paragraphs.length; paragraph++) {
        let at = paragraphs[paragraph]!.indexOf(quote);
        while (at >= 0) {
          const text = paragraphs[paragraph]!;
          const prior = [...text.slice(0, at)].slice(-[...before].length).join('');
          const next = [...text.slice(at + quote.length)].slice(0, [...after].length).join('');
          if (prior === before && next === after) {
            const mapped = mapParagraphSelection(pageMarkdown.replace(/<!--\/?c:[^>]*-->/g, ''), at, at + quote.length, paragraph);
            if (mapped.ok && mapped.range.start === sourceStart && mapped.range.end === sourceEnd) matches++;
          }
          at = text.indexOf(quote, at + 1);
        }
      }
      if (matches !== 1) return { ok: false, status: 409, message: `${document}: marker pair ${thread} does not uniquely match its saved quote and context` };
      entries.push({ message: file.slice(0, -3), thread, document, anchor, author: String(parsed.message.author), time: String(parsed.message.time), status: String(parsed.message.status), body: parsed.body });
    }
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
