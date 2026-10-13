/**
 * The product's kinds registry, read from the product folder (decision 0021,
 * outcome 3 of the standalone charter): the file the skill set writes at
 * setup, at `docs/kinds.yaml` — the place the contract's example and
 * capability spec pin. What a registry may hold is the contract's own
 * reading (`parseContractText` in `src/product/contract.ts`); this module
 * only finds the file in the product and hands its text over. A product
 * with no registry file reads as one without a registry: nothing is
 * invented, and the pages keep the plain behaviour they had. When the file
 * stands but does not read, the refusals are values — the contract's own
 * words, the file and the line each — and the pages keep the plain
 * behaviour, the refusals surfacing wherever the wiki reports problems.
 * Nothing here writes, and nothing reads the clock.
 */
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { parseContractText, type ContractError, type RegistryKind, type RegistryLink, type RegistryStage } from './contract.js';

/** The file the kinds registry is read from, relative to the product folder. */
export const REGISTRY_FILE = 'docs/kinds.yaml';

/** What reading the product's kinds registry gave. */
export type ProductRegistry =
  /** The product holds none: every page keeps the plain behaviour, the stages the mechanism's own. */
  | { present: false }
  /** The registry reads whole: its stages, in the list's order, and its kinds. */
  | { present: true; kinds: RegistryKind[]; stages: RegistryStage[] }
  /** The file stands but does not read: the contract's refusals, each naming the file, the line, the field's path and the words. */
  | { present: true; refused: ContractError[] };

/**
 * Reads the product's kinds registry, fresh, from the product folder. The
 * file itself is judged like the pages are: a symlink standing in its place
 * is followed only when it points back at that very place in the product, so
 * the registry cannot be smuggled in from another folder.
 */
export function readProductRegistry(productFolder: string): ProductRegistry {
  const file = `${productFolder}/${REGISTRY_FILE}`;
  // The presence check is the name's own: a dangling or closed-loop symlink
  // standing in the registry's place is not an absence, and the read below
  // refuses it with its cause instead of reading as no registry at all.
  let stands: boolean;
  try {
    lstatSync(file);
    stands = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return { present: false };
    throw error;
  }
  if (!stands) return { present: false };
  // A non-regular file — a FIFO, a socket, a device — is never opened:
  // the read below would block on it for good, so it is refused by name
  // before the read is even tried, the way the page walk refuses a
  // non-regular page (finding 2). A symlink that stat cannot resolve at
  // all (dangling, closed loop) falls through to the resolution refusal
  // beneath, exactly as it read before this gate stood here.
  let regular: boolean | undefined;
  try {
    regular = statSync(file).isFile();
  } catch {
    regular = undefined;
  }
  if (regular === false) {
    return {
      present: true,
      refused: [{
        file: REGISTRY_FILE,
        line: 0,
        path: '',
        message: `${REGISTRY_FILE} is not a regular file, so the wiki does not open it — the wiki serves these pages as plain documents`,
      }],
    };
  }
  try {
    const real = realpathSync(file);
    const productReal = realpathSync(productFolder);
    if (real !== `${productReal}/${REGISTRY_FILE}`) {
      return {
        present: true,
        refused: [{
          file: REGISTRY_FILE,
          line: 0,
          path: '',
          message: `the registry file is a symlink the product does not hold: it points at ${real}, away from the place madarch reads`,
        }],
      };
    }
  } catch (error) {
    return {
      present: true,
      refused: [{ file: REGISTRY_FILE, line: 0, path: '', message: `the registry file could not be resolved: ${(error as Error).message}` }],
    };
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return {
      present: true,
      refused: [{ file: REGISTRY_FILE, line: 0, path: '', message: `the registry file could not be read: ${(error as Error).message}` }],
    };
  }
  const read = parseContractText(REGISTRY_FILE, text);
  if (!read.ok) {
    return { present: true, refused: [...read.errors] };
  }
  return { present: true, kinds: read.kinds, stages: read.stages };
}

// ---- what the wiki needs from a read registry -----------------------------

/**
 * The kinds registry as the page reader uses it: the kinds and stages as the
 * file ordered them, the kinds by their id prefix (a document's identity
 * line names its kind through the prefix), the kinds by their folders (a
 * document's place names its kind through them — a file folder matches by
 * the whole path, a folder one by what sits inside, the longest folder
 * winning) and the id shape a document's id may carry, per kind's prefix,
 * the longest prefixes first so `US` and `S` never share one match.
 */
export interface RegistryKit {
  kinds: RegistryKind[];
  stages: RegistryStage[];
  /** The kind each id prefix names. */
  readonly byPrefix: Map<string, RegistryKind>;
  /** The whole id shape: `(?:US|UC|FR|PRA|S|H|Q|P|R)-\d{3,}`, prefixes longest first. */
  readonly idShape: RegExp;
  /** The same shape as one body's scanner: every id a line names, outside code spans. */
  readonly mentionShape: RegExp;
  /** The kinds' folders, longest first, each with its kind. */
  readonly folderKinds: readonly { folder: string; kind: RegistryKind }[];
  /**
   * The id a document of a file-kind carries without an identity line: the
   * file stem's capitals (a kind whose folder is `docs/vision.md` is
   * addressed as `VISION`). The product's own documents decide when the
   * address is used — the reader links on it only where they name it.
   */
  readonly fileAddresses: Map<string, string>;
}

/**
 * One kind's declared links and allowed statuses, as the page reader walks
 * them: the links in the file's own order, the targets as the file named
 * them, and the kind's name beside them — a link's resolution needs the
 * target document's kind, not the declaring kind's.
 */
export interface KindLinks {
  /** The kind the links belong to. */
  kind: RegistryKind;
  /** The kind's declared links, in the file's order; the field names lowercased beside the written ones. */
  readonly links: readonly { declared: RegistryLink; key: string }[];
  /** The kind's allowed statuses, lowercased, in the file's order; empty when the kind names none. */
  readonly statuses: readonly string[];
}

/**
 * The declared links of one kind, by the kind's own name (case does not
 * matter here — the documents name their kind by any casing the header or
 * the path gave it). A kind with no declared links reads as one with none.
 */
export function kindLinksOf(kit: RegistryKit, kindName: string | undefined): KindLinks | undefined {
  if (kindName === undefined) return undefined;
  const kind = kit.kinds.find((entry) => entry.name.toLowerCase() === kindName.toLowerCase());
  if (kind === undefined) return undefined;
  return {
    kind,
    links: (kind.links ?? []).map((declared) => ({ declared, key: declared.field.toLowerCase() })),
    statuses: (kind.statuses ?? []).map((status) => status.toLowerCase()),
  };
}

/** Builds the page reader's kit from one read registry (or none). */
export function registryKit(registry: ProductRegistry): RegistryKit | undefined {
  if (!registry.present) return undefined;
  if ('refused' in registry) return undefined;
  for (const kind of registry.kinds) {
    kind.links = [...(kind.links ?? [])].map((link) => ({
      field: link.field,
      targets: [...link.targets],
      backlink: link.backlink,
      cardinality: link.cardinality ?? 'many',
      required: link.required ?? false,
    }));
    kind.statuses = kind.statuses === undefined ? undefined : [...kind.statuses];
  }
  const kinds: RegistryKind[] = registry.kinds;
  const prefixes = [...new Set(kinds.map((kind) => kind.prefix))].sort((a, b) => a.length > b.length ? -1 : a.length < b.length ? 1 : byCodePoint(a, b));
  const byPrefix = new Map<string, RegistryKind>();
  for (const kind of kinds) if (!byPrefix.has(kind.prefix)) byPrefix.set(kind.prefix, kind);
  const folderKinds = kinds
    .map((kind) => ({ folder: `${kind.folder}${kind.folder.endsWith('/') ? '' : '/'}`, kind }))
    .sort((a, b) => (a.folder.length > b.folder.length ? -1 : a.folder.length < b.folder.length ? 1 : byCodePoint(a.folder, b.folder)));
  const fileAddresses = new Map<string, string>();
  for (const kind of kinds) {
    if (!kind.folder.endsWith('.md')) continue;
    const stem = kind.folder.slice(kind.folder.lastIndexOf('/') + 1, kind.folder.length - '.md'.length);
    const address = stem.toUpperCase();
    if (!fileAddresses.has(address)) fileAddresses.set(address, kind.folder);
  }
  return {
    kinds,
    stages: registry.stages,
    byPrefix,
    idShape: new RegExp(`^(?:${prefixes.join('|')})-\\d{3,}$`),
    mentionShape: new RegExp(`(?<![\\w-])(?:${prefixes.join('|')})-\\d{3,}(?![\\w-])`, 'g'),
    folderKinds,
    fileAddresses,
  };
}

/** The kind a document's path names: the exact file, else the shortest walk, the longest folder's kind. */
export function kindOfPath(kit: RegistryKit, path: string): RegistryKind | undefined {
  for (const held of kit.folderKinds) {
    if (held.kind.folder.endsWith('.md')) {
      if (path === held.kind.folder) return held.kind;
      continue;
    }
    if (path.startsWith(held.folder)) return held.kind;
  }
  return undefined;
}

/** The kind a document's id names, through its prefix. */
export function kindOfId(kit: RegistryKit, id: string): RegistryKind | undefined {
  return kit.byPrefix.get(id.slice(0, id.indexOf('-'))) ?? undefined;
}

/** A sceneless code point comparison, so a folder tie order is never locale's. */
function byCodePoint(a: string, b: string): number {
  const ca = [...a].map((char) => char.codePointAt(0) ?? 0);
  const cb = [...b].map((char) => char.codePointAt(0) ?? 0);
  const shorter = Math.min(ca.length, cb.length);
  for (let at = 0; at < shorter; at++) {
    const x = ca[at] as number;
    const y = cb[at] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return ca.length === cb.length ? 0 : ca.length < cb.length ? -1 : 1;
}
