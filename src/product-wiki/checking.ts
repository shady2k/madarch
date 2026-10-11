/**
 * The set's product check, run over a served product's folder: the check
 * the set owns (`check-product.mjs`) refuses a product document out of form
 * and names file, line and what is wrong; the wiki runs it and places its
 * findings on the page that fails them (the product-wiki requirement
 * `front-matter`). The run is one child process per product revision — the
 * wiki caches a run by the revision its pages digest gave, so a quiet
 * product runs the check once and a saved file runs it again with the next
 * event, never per page request.
 *
 * The check itself reads the product's working tree and changes nothing.
 * Where the check cannot be run — no script, no node, output unreadable —
 * the run fails loudly, naming the script it asked for and the cause; the
 * wiki shows that name rather than passing the product as checked.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname as dirOf, join as joinPath, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One finding as the set's check reports it: the rule, file, line, the words. */
export interface ProductFinding {
  rule: string;
  file: string;
  line: number;
  what: string;
  why?: string | null;
  /** A note the check reports without refusing (an outside-source quote). */
  note?: boolean;
}

/** One check run: the set's rules version and its findings, or the refusal naming why nothing ran. */
export type ProductCheckRun =
  | { ran: true; version: string; findings: ProductFinding[] }
  | { ran: false; message: string };

/** How long one check run may take before the wiki calls it failed. */
export const CHECK_TIMEOUT_MS = 30_000;

/** The repo the madarch checkout is, resolved from this module's own place. */
const REPO_ROOT = dirOf(dirOf(dirOf(fileURLToPath(import.meta.url))));

/**
 * Where the set's check-script of this checkout stands, or the one
 * `MADARCH_PRODUCT_CHECK` names — the set's own installation is the
 * checkout's `.shady2k/checks`; a deployment that keeps it elsewhere names
 * it by the environment variable.
 */
export function productCheckScript(): { ok: true; path: string } | { ok: false; message: string } {
  const namedUnder = process.env['MADARCH_PRODUCT_CHECK'];
  const path = namedUnder !== undefined && namedUnder.trim() !== '' ? normalize(namedUnder.trim()) : joinPath(REPO_ROOT, '.shady2k', 'checks', 'check-product.mjs');
  if (!existsSync(path)) {
    return {
      ok: false,
      message:
        `the set's product check was not found at ${path}` +
        (namedUnder !== undefined && namedUnder.trim() !== '' ? ` (MADARCH_PRODUCT_CHECK)` : '') +
        `: the wiki serves the pages, but it cannot check them until the check's script is there`,
    };
  }
  return { ok: true, path };
}

/** The findings of one run over a folder, or the refusal naming script and cause. */
export function runProductCheck(productFolder: string): ProductCheckRun {
  const script = productCheckScript();
  if (!script.ok) return { ran: false, message: script.message };
  const runners = ['node', process.execPath] as const;
  let lastFailure = '';
  for (const runner of runners) {
    const run = spawnSync(runner, [script.path, '--root', productFolder, '--json'], {
      encoding: 'utf8',
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 1 << 24,
    });
    // `spawnSync`'s error is what could not even start; the runner then is
    // not the node the script needs, so the next runner is tried.
    if (run.error !== undefined) { lastFailure = `${runner}: ${run.error.message}`; continue; }
    if (run.signal !== null) {
      return {
        ran: false,
        message: `the set's product check at ${script.path} was killed by ${run.signal} when reading ${JSON.stringify(productFolder)}; its run took longer than ${CHECK_TIMEOUT_MS} ms or stopped — rerun the server to try again`,
      };
    }
    const status = run.status;
    if (status !== 0 && status !== 1) {
      return {
        ran: false,
        message: `the set's product check at ${script.path} refused its input reading ${JSON.stringify(productFolder)} (exit ${String(status)}): ${run.stderr.trim() || 'the check named what was wrong on standard error'}`,
      };
    }
    try {
      const answer = JSON.parse(run.stdout) as { version: string; findings: ProductFinding[] };
      return { ran: true, version: answer.version, findings: answer.findings };
    } catch {
      return {
        ran: false,
        message: `the set's product check at ${script.path} answered no JSON reading ${JSON.stringify(productFolder)} (exit ${String(status)}): ${run.stdout.slice(0, 200)}`,
      };
    }
  }
  return { ran: false, message: `the set's product check could not be run at ${script.path}: no runner launched it (tried ${runners.join(', ')}); last failure ${lastFailure}` };
}

/**
 * A per-revision memory of check runs: one product revision — the digest
 * the pages gave — answers its own run; up to the last few revisions are
 * kept, the oldest falling away when the product changes again.
 */
export class CheckRunCache {
  private readonly entries = new Map<string, ProductCheckRun>();

  constructor(private readonly capacity = 8) {}

  /** The run of this revision, computed once per revision through `produce`. */
  run(revision: string, produce: () => ProductCheckRun): ProductCheckRun {
    const held = this.entries.get(revision);
    if (held !== undefined) {
      // LRU touch: remove and set back, so the oldest read falls away last.
      this.entries.delete(revision);
      this.entries.set(revision, held);
      return held;
    }
    const run = produce();
    while (this.entries.size >= this.capacity && this.entries.size > 0) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value as string);
    }
    this.entries.set(revision, run);
    return run;
  }
}
