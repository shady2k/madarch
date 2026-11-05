/**
 * The unit a file belongs to, read from the manifests above its folder
 * (madarch-8bdc.2.4, step 1 of the port's prerequisites).
 *
 * The extract driver's `serviceUnits(tree)` scans every path of a tree for a
 * `go.mod` or a `package.json` and indexes the units by the folder each
 * manifest governs. A static unit may not list the tree, so this module asks the
 * same question one path at a time: it walks the file's folder up to the
 * repository root, and at each folder asks for the two manifest names the
 * extractor reads. The declaration is read from the manifest's own bytes — the
 * 0028 graph holds no manifest declaration on this branch, so a read by
 * property could answer only the file's existence, which the path-scoped entry
 * already answers. Every answer is one path: no listing, no whole tree.
 *
 * **The rules are `serviceUnits`' own.** A `go.mod` declares the last segment
 * of its module path; a `package.json` declares its `name`, and a manifest that
 * names nothing is known by its folder. A manifest that declares nothing (a
 * `go.mod` with no module, a root `package.json` with no name) is passed over
 * and the walk continues to the ancestor that does declare. A folder the
 * repository conventions call another project's is passed over too. Where one
 * folder holds both manifests, the smaller declared name answers, and
 * `go.mod` answers a tie, which is the order `serviceUnits` indexes them in.
 *
 * **What the answer pins.** The result carries the chain of manifest blobs the
 * walk saw, nearest first: a manifest that appears, disappears or moves above a
 * file changes that chain, so the code-facts stage plans the file again even
 * though the file's own bytes did not move. A manifest that is a submodule or
 * above the static reading cap is a named gap: its declaration cannot be read,
 * and the walk continues to the ancestor, as `serviceUnits` continues past a
 * manifest whose bytes it could not read.
 */
import {byCodePoint} from '../../model/order.js';
import {repositoryConventions} from '../../extract/library-models/repository-conventions.js';
import {readGoMod} from './manifest-format.js';

/** The two manifest names the extract driver's unit index is built from, in the tree's path order. */
const MANIFEST_NAMES: readonly string[] = ['go.mod', 'package.json'];

/** The folder names the repository conventions call another project's manifest: no unit is declared there. */
const FOREIGN_FOLDERS: ReadonlySet<string> = new Set(repositoryConventions.foreignManifestFolders.map((entry) => entry.folder));

/** One unit a file belongs to, as `serviceUnits` declares it. */
export interface ServiceMembership {
  /** The declaration's last path segment (`training.example/orders` is `orders`, `@acme/web` is `web`). */
  readonly name: string;
  /** The folder the declaration governs, `''` for the repository root. */
  readonly root: string;
  /** The manifest that declares it. */
  readonly manifestPath: string;
  readonly ecosystem: 'go' | 'node';
  /** The whole declared identity, as the manifest writes it. */
  readonly declared: string;
}

/** One manifest the walk found: its path and the blob its bytes stood under. */
interface ManifestAt {
  readonly path: string;
  readonly blob: string;
}

/** What one file's membership read answered: the unit where one declares, the manifest chain the walk saw, and its gaps. */
export interface ServiceMembershipRead {
  readonly unit?: ServiceMembership;
  /** Every manifest above the file, nearest first, as `<path>@<blob>`: what the reading stands on. */
  readonly chain: readonly string[];
  /** The manifests whose declaration could not be read, each naming its path and why. */
  readonly gaps: readonly string[];
}

/** One manifest's entry in the pinned tree: its blob, and its bytes where the caller can read them. */
export interface ManifestEntry extends ManifestAt {
  readonly bytes?: Uint8Array;
}

/** How a caller looks a manifest path up: one path-scoped answer, never a listing. */
export type ManifestLookup = (path: string) => Promise<ManifestEntry | undefined>;

/** The folder a repository path stands in, `''` for the repository root. */
export const folderOf = (path: string): string => {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
};

const segmentsOf = (path: string): string[] => (path === '' ? [] : path.split('/').filter((part) => part !== '' && part !== '.'));

const lastSegment = (value: string): string => {
  const parts = value.split('/').filter((part) => part !== '' && part !== '.');
  return parts[parts.length - 1] ?? '';
};

/** Whether the repository conventions call a folder another project's: its manifest declares no unit of this repository. */
const foreign = (folder: string): boolean => segmentsOf(folder).some((segment) => FOREIGN_FOLDERS.has(segment));

/** The manifest chain above one folder, nearest first: every `go.mod` and `package.json` the pinned tree holds there or above. */
export async function manifestChainOf(folder: string, lookup: ManifestLookup): Promise<readonly string[]> {
  const chain: string[] = [];
  let at = folder;
  for (;;) {
    if (!foreign(at)) {
      for (const name of MANIFEST_NAMES) {
        const path = at === '' ? name : `${at}/${name}`;
        const entry = await lookup(path);
        if (entry !== undefined) chain.push(`${entry.path}@${entry.blob}`);
      }
    }
    if (at === '') return chain;
    at = folderOf(at);
  }
}

/**
 * The unit one file belongs to, and the manifest chain the answer stands on.
 * The nearest folder whose manifest declares a unit answers; a manifest that
 * declares nothing is passed over and the walk continues, exactly as
 * `serviceUnits`' folder index answers for a path.
 */
export async function serviceMembershipOf(path: string, lookup: ManifestLookup): Promise<ServiceMembershipRead> {
  // The folders above the file, nearest first: the chain walks all of them, and the unit is
  // decided by the first that declares one.
  const folders: string[] = [];
  for (let at = folderOf(path); ; at = folderOf(at)) {
    folders.push(at);
    if (at === '') break;
  }
  const found: { readonly folder: string; readonly entries: readonly ManifestEntry[] }[] = [];
  const chain: string[] = [];
  for (const folder of folders) {
    if (foreign(folder)) continue;
    const entries: ManifestEntry[] = [];
    for (const name of MANIFEST_NAMES) {
      const entry = await lookup(folder === '' ? name : `${folder}/${name}`);
      if (entry !== undefined) entries.push(entry);
    }
    if (entries.length > 0) found.push({ folder, entries });
    for (const entry of entries) chain.push(`${entry.path}@${entry.blob}`);
  }
  const gaps: string[] = [];
  for (const { folder, entries } of found) {
    let chosen: ServiceMembership | undefined;
    for (const entry of entries) {
      if (entry.bytes === undefined) {
        gaps.push(`${entry.path}:1: the manifest is not readable as text (a submodule or a file above the static reading cap), so the unit it declares is unknown`);
        continue;
      }
      const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
      const declared = declarationOf(name, folder, entry.bytes);
      if (declared === undefined) continue;
      // `serviceUnits` indexes one unit per folder: the smaller declared name wins, and the
      // manifests are read in the tree's own path order (`go.mod` before `package.json`).
      if (chosen === undefined || byCodePoint(declared.name, chosen.name) < 0) chosen = declared;
    }
    if (chosen !== undefined) return { unit: chosen, chain, gaps };
  }
  return { chain, gaps };
}

/**
 * What one manifest declares, by the rules `serviceUnits` reads it with: a
 * `go.mod`'s module path, a `package.json`'s name, and a package manifest that
 * names nothing known by its folder. A `go.mod` with no module declares
 * nothing, and the walk continues to the ancestor.
 */
function declarationOf(name: string, folder: string, bytes: Uint8Array): ServiceMembership | undefined {
  const text = new TextDecoder('utf-8', {fatal: false}).decode(bytes);
  let declared: string | undefined;
  let ecosystem: 'go' | 'node' = 'node';
  if (name === 'go.mod') {
    ecosystem = 'go';
    const read = readGoMod(text);
    declared = read.ok ? read.value.module.trim() : undefined;
  } else {
    try {
      const manifest = JSON.parse(text) as {name?: unknown};
      if (typeof manifest.name === 'string' && manifest.name.trim() !== '') declared = manifest.name.trim();
    } catch {
      // A manifest whose bytes are not JSON declares no name here; its folder names the unit,
      // as `serviceUnits` reads the same bytes.
    }
    if (declared === undefined) declared = lastSegment(folder);
  }
  if (declared === undefined || declared === '') return undefined;
  const nameOfUnit = lastSegment(declared);
  if (nameOfUnit === '') return undefined;
  const manifestPath = folder === '' ? name : `${folder}/${name}`;
  return {name: nameOfUnit, root: folder, manifestPath, ecosystem, declared};
}
