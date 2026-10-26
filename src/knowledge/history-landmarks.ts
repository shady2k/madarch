/** Repository-owned historical landmarks. No product snapshot configuration exists. */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { walkDefaultBranch, type CommitFact } from '../extract/driver/git.js';
import { byCodePoint } from '../model/order.js';

const execute = promisify(execFile);
/** Implementation safety bound for earlier trees; the tip is separate. */
export const MAX_HISTORY_LANDMARK_TREES = 64;
/** Bounds tag parsing, peel work and unsupported diagnostics independently of tree reads. */
export const MAX_HISTORY_LANDMARK_TAGS = 512;
export interface LandmarkDiagnostic { ref: string; object: string; reason: string }
/** This plan is stored in the same database snapshot as its graph, never a sidecar. */
export interface LandmarkPlan {
  head: string;
  snapshots: Record<string, string>;
  points: string[];
  limit: number;
  omitted: number;
  diagnostics: LandmarkDiagnostic[];
}
export interface LandmarkCoverage {
  offered: number;
  covered: number;
  limit: number;
  overflow: boolean;
  omitted: number;
  /** Bounds of individually covered trees, NOT a continuous covered interval. */
  first: string | null;
  last: string | null;
  diagnostics: LandmarkDiagnostic[];
}

/** Budget follows ancestry generation, never raw commit dates or tag naming conventions. */
export function planLandmarks(walk: readonly CommitFact[], tags: readonly { ref: string; object: string; commit?: string; reason?: string }[]): LandmarkPlan {
  const first = walk[0]; const last = walk[walk.length - 1];
  if (first === undefined || last === undefined) throw new Error('historical landmarks: no first-parent commit');
  const onLine = new Map(walk.map((commit) => [commit.hash, commit]));
  const snapshots: Record<string, string> = { first: first.hash, last: last.hash };
  const diagnostics: LandmarkDiagnostic[] = [];
  for (const tag of [...tags].sort((a, b) => byCodePoint(a.ref, b.ref))) {
    if (tag.commit === undefined || !onLine.has(tag.commit)) {
      diagnostics.push({ ref: tag.ref, object: tag.commit ?? tag.object, reason: tag.reason ?? `commit is outside the pinned first-parent ancestry of ${last.hash}` });
    } else snapshots[tag.ref] = tag.commit;
  }
  const named = Object.entries(snapshots).filter(([, commit]) => commit !== last.hash && commit !== first.hash)
    .sort(([a, ac], [b, bc]) => onLine.get(bc)!.generation - onLine.get(ac)!.generation || byCodePoint(a, b));
  const selected = new Set<string>();
  if (first.hash !== last.hash) selected.add(first.hash);
  for (const [, commit] of named) if (selected.size < MAX_HISTORY_LANDMARK_TREES) selected.add(commit);
  const earlier = new Set(Object.values(snapshots).filter((commit) => commit !== last.hash));
  return { head: last.hash, snapshots, points: [...selected], limit: MAX_HISTORY_LANDMARK_TREES,
    omitted: earlier.size - selected.size, diagnostics };
}

/** Every Git tag is considered; no guessed release prefix or fixture identity is read. */
export async function repositoryLandmarks(repository: string, ref: string): Promise<LandmarkPlan> {
  const walk = walkDefaultBranch(repository, ref);
  const git = async (args: string[]): Promise<string> => {
    try {
      return (await execute('git', args, { cwd: repository, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })).stdout;
    } catch (error) {
      throw new Error(`historical landmarks: ${repository}: git ${args.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
  const output = await git(['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)%00%(objecttype)%00', 'refs/tags/']);
  const fields = output.split('\0');
  if (fields.length > 3 * MAX_HISTORY_LANDMARK_TAGS + 1) throw new Error(`historical landmarks: ${repository}: more than ${MAX_HISTORY_LANDMARK_TAGS} Git tags exceed the discovery/diagnostic bound; no partial landmark plan was accepted`);
  const tags: { ref: string; object: string; commit?: string; reason?: string }[] = [];
  const peelTags: typeof tags = [];
  for (let index = 0; index < fields.length - 1; index += 3) {
    const field = fields[index]!; const tag = field.startsWith('\n') ? field.slice(1) : field;
    const object = fields[index + 1]; const type = fields[index + 2];
    if (tag === '' || object === undefined || object === '' || type === undefined) throw new Error(`historical landmarks: ${repository}: incomplete Git tag record at field ${index}`);
    const entry: (typeof tags)[number] = { ref: tag, object }; tags.push(entry);
    if (type === 'blob' || type === 'tree') entry.reason = `tag names a ${type}, not a commit`;
    else if (type === 'commit' || type === 'tag') peelTags.push(entry);
    else throw new Error(`historical landmarks: ${repository}: git for-each-ref returned unsupported object type ${type} for ${tag} at ${object}`);
  }
  if (peelTags.length > 0) {
    // One bounded Git protocol exchange, not an unbounded process per tag.
    // Peeling reports the actual target type. A missing object or process error
    // fails discovery rather than being relabelled an unsupported landmark.
    let peeled: string;
    try {
      peeled = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
        cwd: repository, input: peelTags.map((tag) => `${tag.ref}^{}\n`).join(''), encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`historical landmarks: ${repository}: git cat-file --batch-check failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const records = peeled.split('\n');
    if (records.pop() !== '' || records.length !== peelTags.length) throw new Error(`historical landmarks: ${repository}: git cat-file answered ${records.length} records for ${peelTags.length} tags`);
    for (const [index, tag] of peelTags.entries()) {
      const record = records[index]!;
      if (record === `${tag.ref}^{} missing`) throw new Error(`historical landmarks: ${repository}: git cat-file could not read commit/tag ${tag.ref} at ${tag.object}; missing or corrupt object, no partial plan accepted`);
      else {
        const [object, type, extra] = record.split(' ');
        if (object === undefined || object === '' || extra !== undefined) throw new Error(`historical landmarks: ${repository}: invalid git cat-file record for ${tag.ref}: ${record}`);
        if (type === 'commit') tag.commit = object;
        else if (type === 'blob' || type === 'tree') tag.reason = `tag peels to a ${type} at ${object}, not a commit`;
        else throw new Error(`historical landmarks: ${repository}: git cat-file returned ${String(type)} for ${tag.ref} at ${object}`);
      }
    }
  }
  return planLandmarks(walk, tags);
}
