/**
 * The send command's logic (the server capability's send requirement,
 * docs/changes/server-views/capabilities/server.md): a repository's model
 * is sent to a madarch server only after its check passes, with the
 * source's name, the revision's commit id and its committer time. The
 * model is read from the working tree, as the check reads it, so a model
 * written but not committed yet — the skill's own run — can be sent.
 */
import { spawnSync } from 'node:child_process';
import { checkModel, type ModelCheckReport } from '../check/model-check.js';
import { loadAndCompileModel } from '../model/load-and-compile.js';

/** How sending ended; the script prints each kind and maps it onto its exit code. */
export type SendResult =
  | { outcome: 'stored' | 'already-stored'; source: string; commit: string }
  | { outcome: 'check-failed'; report: ModelCheckReport }
  | { outcome: 'unreadable'; report: ModelCheckReport }
  | { outcome: 'no-source-name'; problem: string }
  | { outcome: 'revision-unreadable'; problem: string }
  | { outcome: 'no-model'; problem: string }
  | { outcome: 'unreachable'; server: string; cause: string }
  | { outcome: 'refused'; status: number; message: string; field?: string }
  | { outcome: 'bad-answer'; status: number; problem: string };

export interface SendOptions {
  /** The repository whose model is sent. */
  repoPath: string;
  /** The address of the madarch server, as `POST <server>/models` is addressed. */
  server: string;
  /** The source's name; left out, the `origin` remote names it. */
  source?: string;
  /** The revision the model is checked and sent at; `HEAD` by default. */
  rev?: string;
}

/**
 * Checks the repository (as `check-model.ts` checks it) and, only on a
 * passing check, sends the compiled model to the server. Every way the
 * send can fall short is named in the result: the check's own report,
 * a missing source name, a revision git cannot read, a model that stopped
 * compiling between the check and the send, a server that cannot be
 * reached, and a refusal or a non-answer from the server.
 */
export async function sendModel(options: SendOptions): Promise<SendResult> {
  const report = checkModel(options.repoPath, { rev: options.rev });
  if (report.outcome === 'failed') return { outcome: 'check-failed', report };
  if (report.outcome === 'unreadable') return { outcome: 'unreadable', report };

  let source: string;
  if (options.source !== undefined) {
    source = options.source;
  } else {
    const origin = originSourceName(options.repoPath);
    if ('problem' in origin) return { outcome: 'no-source-name', problem: origin.problem };
    source = origin.name;
  }

  const rev = options.rev ?? 'HEAD';
  const commitRun = git(options.repoPath, ['rev-parse', '--verify', `${rev}^{commit}`]);
  if (!commitRun.ok) return { outcome: 'revision-unreadable', problem: `the revision "${rev}" could not be resolved to a commit; nothing was sent` };
  const commit = commitRun.stdout.trim();
  const timeRun = git(options.repoPath, ['log', '-1', '--format=%cI', commit]);
  if (!timeRun.ok || timeRun.stdout.trim() === '') {
    return { outcome: 'revision-unreadable', problem: `the committer time of the revision "${rev}" could not be read; nothing was sent` };
  }
  const committedAt = timeRun.stdout.trim();

  // The check read the model from the working tree and passed it; the
  // compiled model is read the same way. If it no longer compiles, the
  // files changed under the check — naming that is better than sending
  // something the check never saw.
  const { model, errors } = loadAndCompileModel(options.repoPath);
  if (model === undefined || errors.length > 0) {
    const why = errors.map((error) => `${error.file}:${error.line}: ${error.message}`).join('; ') || 'nothing was read';
    return { outcome: 'no-model', problem: `the model that passed the check no longer compiles: ${why}; nothing was sent` };
  }

  let response: Response;
  try {
    response = await fetch(`${options.server.replace(/\/+$/, '')}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, commit, committedAt, model }),
    });
  } catch (error) {
    return { outcome: 'unreachable', server: options.server, cause: error instanceof Error ? error.message : String(error) };
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (response.status === 200 || response.status === 201) {
    if (typeof body === 'object' && body !== null && 'stored' in body && typeof body.stored === 'boolean') {
      return { outcome: body.stored ? 'stored' : 'already-stored', source, commit };
    }
    return { outcome: 'bad-answer', status: response.status, problem: 'the body holds no boolean "stored"' };
  }
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error: unknown = body.error;
    if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
      const field: string | undefined = 'field' in error && typeof error.field === 'string' ? error.field : undefined;
      return { outcome: 'refused', status: response.status, message: error.message, field };
    }
  }
  return { outcome: 'bad-answer', status: response.status, problem: 'the body is neither a send answer nor a refusal' };
}

/**
 * The name the repository's `origin` remote gives the source, or the
 * problem that keeps it nameless. The remote URL itself never leaves
 * this function: a refused or unusable origin is named, not quoted, so
 * no credential in it can reach the output or the request.
 */
function originSourceName(repo: string): { name: string } | { problem: string } {
  const url = git(repo, ['remote', 'get-url', 'origin']);
  if (!url.ok) return { problem: 'the repository has no "origin" remote to name the source from; name the source with --source' };
  const name = sourceNameFromRemote(url.stdout.trim());
  if (name === undefined) return { problem: 'the "origin" remote has no host and path to name the source from; name the source with --source' };
  return { name };
}

/** One read-only `git` invocation in the repository. */
function git(repo: string, args: string[]): { ok: boolean; stdout: string } {
  const run = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return { ok: run.status === 0, stdout: run.stdout ?? '' };
}

/**
 * The source name a remote URL names: `git@github.com:shady2k/nocx.git`
 * and `https://user:token@github.com/shady2k/nocx.git` both name
 * `github.com/shady2k/nocx` — the host and path, without a scheme,
 * credentials, a port or a trailing `.git`, so the name is stable across
 * clones and machines and no credential in the URL can reach the output,
 * the logs or the request. `undefined` when the remote has no host and
 * path to name a repository by — a local path, a bare host, a Windows
 * drive letter — leaving the caller to refuse and ask for `--source`.
 */
export function sourceNameFromRemote(url: string): string | undefined {
  const text = url.trim();
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // A scheme URL: the authority holds the host, behind any credentials,
    // and the path follows the first slash after it.
    const afterScheme = text.slice(text.indexOf('://') + 3);
    const slash = afterScheme.indexOf('/');
    if (slash === -1) return undefined;
    const authority = afterScheme.slice(0, slash);
    const at = authority.lastIndexOf('@');
    const hostPort = at === -1 ? authority : authority.slice(at + 1);
    const colon = hostPort.lastIndexOf(':');
    host = colon === -1 ? hostPort : hostPort.slice(0, colon);
    path = afterScheme.slice(slash);
  } else {
    // scp-like: [user@]host:path with a relative path. A one-letter
    // "host" before the colon is a Windows drive letter, not a host.
    const scp = /^(?:[^@/]+@)?([^/:]+):([^/].*)$/.exec(text);
    if (scp === null) return undefined;
    host = scp[1]!;
    if (host.length < 2) return undefined;
    path = `/${scp[2]}`;
  }
  // The query and fragment are not part of the repository's path: an URL
  // like https://host/acme/shop.git?access_token=... carries credentials
  // there that must never reach the source's name.
  path = path.replace(/[?#].*$/, '');
  let name = `${host}${path}`.replace(/\/+$/, '');
  if (name.toLowerCase().endsWith('.git')) name = name.slice(0, -'.git'.length);
  if (host === '' || name === '' || name === host) return undefined;
  return name;
}
