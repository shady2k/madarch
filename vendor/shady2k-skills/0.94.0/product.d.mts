// Type declarations for the vendored program, written in this repository —
// not part of the pinned release (whose file is unmodified; see the folder's
// README). They carry only what madarch reads: the named exports of
// product.mjs, with the shapes of its results as the program's own
// documentation and self-test give them.
//
// A refusal names the file and the line where it is known; the `new` command
// takes the products home from its caller and from nowhere else.

/** The schema version this program writes and reads; the folder layout is fixed by it alone. */
export declare const PRODUCT_SCHEMA_VERSION: 1;
/** The manifest's file, at a product folder's root. */
export declare const MANIFEST_FILE: 'workspace.yaml';
/** The plugin version this program reports where no manifest of the set is beside it. */
export declare const PLUGIN_VERSION: string;

/** How creating a draft ended. `refused` is the command's exit 2, `failed` its exit 1. */
export type ProgramDraftResult =
  | { outcome: 'created'; folder: string; id: string; name: string }
  | { outcome: 'refused'; message: string }
  | { outcome: 'failed'; message: string };

/** One declared code repository of a product's manifest. */
export interface ProgramRepo {
  /** The folder under `repos/` the repository is cloned into. */
  name: string;
  /** The url it is cloned from. */
  url: string;
  /** The branch the clone is taken from, when the manifest declares one. */
  branch?: string;
}

/** A product folder, read: where it is, the fields that never change, and what the manifest declares. */
export interface ProgramIdentity {
  /** The full path of the product folder the manifest was read in. */
  folder: string;
  /** The identifier given at creation; kept for the product's life. */
  id: string;
  /** The product's name: the folder's name for a draft. */
  name: string;
  /** The schema version the manifest was written in. */
  schemaVersion: typeof PRODUCT_SCHEMA_VERSION;
  /** The sets the manifest pins, as `shady2k: <version>` lines; empty when none. */
  skills: Record<string, string>;
  /** The code repositories the manifest declares; empty when none. */
  repos: ProgramRepo[];
}

/** How reading a product folder ended; a refusal names the file and the line. */
export type ProgramRead =
  | { ok: true; product: ProgramIdentity }
  | { ok: false; file: string; line: number; message: string };

/** Extra environment for the draft's own git invocations, merged over a process environment stripped of the loader variables. */
export type ProgramGitEnv = Record<string, string>;

/** Creates a draft product repository under the products home the caller names. */
export declare function createDraft(options?: {
  /** The products home; required in effect — the program reads none from anywhere else. */
  home?: string;
  /** The draft's day, `YYYY-MM-DD`; left out, the local clock decides it. */
  date?: string;
  /** Extra environment for this draft's own git invocations. */
  gitEnv?: ProgramGitEnv;
}): ProgramDraftResult;

/** Reads one product folder's manifest. */
export declare function readProduct(productFolder?: string): ProgramRead;

/** Whether a day is written `YYYY-MM-DD` and is a day the calendar has. */
export declare function whyNotADay(date: string): string | null;

/** Reserves the day's folder name in the products home; exported for the program's own tests. */
export declare function reserveDraftFolder(home: string, day: string): { folder: string; name: string };
