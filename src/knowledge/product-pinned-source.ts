/**
 * The product repository and its linked repositories at the commit a read stands on (ALX-1937, ALX-2086).
 *
 * A reader of the wiki no longer finds the product's own files among the graph's `code.file` rows: the product checkout is
 * pinned to read its manifests, and code comes only from the repositories its manifest links. What a reference to a file
 * of the product itself still needs — its document text, its templates, the place a problem names — is the bytes at the
 * pinned commit, read through the same Git object store the fill reads and the same blob gateway a page's file read uses.
 * The snapshot is the committed tree: a symlink is a link entry and never a file, a submodule is a commit entry, and an
 * uncommitted change of the working tree is not in it.
 */
import { resolve } from 'node:path';
import { productRepositoryId } from '../product/identity.js';
import type { ProductIdentity } from '../product/manifest.js';
import { headCommitOf } from '../product/fill-updates.js';
import { isRepositoryPath, REPOSITORY_FORMS } from '../fill/facts.js';
import { matchesAny } from '../product/manifest/kinds.js';
import { createGitSnapshotSource, type RepositoryPin, type SnapshotReader } from '../plugin/repository-snapshot.js';
import { withSpan } from '../obs/trace.js';
import { boundFileText } from './file-text-shape.js';
import { createHash } from 'node:crypto';

export function visibleSourcePath(path: string, exclude: readonly string[]): boolean {
  return isRepositoryPath(path) && !path.includes('\\') && !path.includes('\0') && !matchesAny(exclude, path);
}

export interface SourceRange {
  readonly from?: number;
  readonly fromColumn?: number;
  readonly to?: number;
  readonly blob?: string;
}

export function sourceRange(blob: string, options: SourceRange) {
  const moved = options.blob !== undefined && options.blob !== blob;
  return {
    moved,
    from: moved ? 1 : Math.max(1, Math.trunc(options.from ?? 1)),
    ...(moved || options.fromColumn === undefined ? {} : { fromColumn: Math.max(1, Math.trunc(options.fromColumn)) }),
    ...(moved || options.to === undefined ? {} : { to: Math.trunc(options.to) }),
  };
}

export function sourceTextOf(content: string, options: SourceRange) {
  const bytes = Buffer.byteLength(content);
  const blob = createHash('sha1').update(`blob ${bytes}\0`).update(content).digest('hex');
  const { from, fromColumn = 1, to, moved } = sourceRange(blob, options);
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const range = lines.slice(from - 1, to);
  const text = range.length === 0 ? '' : [range[0]!.slice(fromColumn - 1), ...range.slice(1)].join('\n') + (content.endsWith('\n') || (to ?? lines.length) < lines.length ? '\n' : '');
  return { ...boundFileText(text, from, fromColumn), bytes, blob, from, lines: lines.length, binary: false, ...(moved ? { moved: true } : {}) };
}

/** Pin only repositories in the reader's product context, opening a tree only when asked for. */
export function pinnedProductSources(product: ProductIdentity, revisions: ReadonlyMap<string, string>) {
  const folder = resolve(product.folder);
  const own = productRepositoryId(product);
  const roots = new Map([[own, folder], ...product.repos.map(({ name }) => [name, resolve(folder, 'repos', name)] as const)]);
  const pins = new Map<string, RepositoryPin>();
  const snapshots = createGitSnapshotSource(() => [...pins.values()], { readersHeld: roots.size });
  return async (repository: string | null, path: string, exclude: readonly string[]): Promise<{ pin: RepositoryPin; reader: SnapshotReader; blob: string } | undefined> => {
    if (!visibleSourcePath(path, exclude)) return undefined;
    const id = repository ?? own;
    const root = roots.get(id);
    if (root === undefined) return undefined;
    let pin = pins.get(id);
    if (pin === undefined) {
      const commit = revisions.get(id) || headCommitOf(root)?.commit;
      if (!commit) return undefined;
      pin = { id, form: REPOSITORY_FORMS[id === own ? 1 : 0], root, commit };
      pins.set(id, pin);
    }
    return await withSpan('knowledge.pinned-source', { 'madarch.product': folder }, async () => {
      const reader = await snapshots.open(id);
      const entry = reader.entry(path);
      return entry?.form === 'blob' ? { pin, reader, blob: entry.id } : undefined;
    });
  };
}
