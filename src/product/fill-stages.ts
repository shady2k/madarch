/**
 * The wiring of a product's deterministic fill (madarch-tzte.21.8; decision 0026's
 * stages 0 to 7, decision 0027's host).
 *
 * The orchestrator host (`src/fill/orchestrator-host.ts`) takes one product's
 * wiring from its caller: how the pinned snapshot is read, how the product's
 * configuration resolves, which graph a unit's tracked reads answer from, which
 * named inputs a unit's facts stand on, and where a published fact set lands.
 * This module is that caller for a product that stands in a folder with a
 * manifest: the eight deterministic stages of `src/fill/stages/index.ts`,
 * registered over the product's own repositories, and the reads they make
 * answered from the fill's fact store.
 *
 * **The pins.** The run stands on the product repository and on every code
 * repository its manifest declares (0026, stage 0: "code repositories and the
 * product repository"), each read at the commit its checkout's HEAD names — the
 * product's own folder for the product repository, `<folder>/repos/<name>` for a
 * declared one. Nothing here guesses a commit: a folder that is no Git checkout,
 * and a product whose name is no repository name, are refused by name.
 *
 * The pins are read when a run **plans** — the orchestrator asks the wiring for
 * the run's snapshot first, and the snapshot is read here from a fresh read of
 * them (`repin`) — and every other answer the wiring gives (the snapshot record,
 * a unit's inputs, the sources a stage reads its bytes through) reads that same
 * read. So one run stands on one commit of each repository however often its
 * stages ask, and a run that plans later — the second run of a product in one
 * process, or a resume — reads the pins again rather than standing on the first
 * run's commit in silence.
 *
 * **The snapshot record.** `RunSnapshot` is fill-runtime's own shape, kept by
 * decision 0027, and it names one repository: this wiring names the product
 * repository (its folder, the branch its HEAD stands on and its commit), because
 * that is the commit the run was asked for and the repository a person fills.
 * The other repositories' commits are the pins, which every stage reads for
 * itself; the field cannot carry them all and this module does not pretend it
 * does. `registryHash` is the digest of the *declared stages* — their ids and
 * versions, in code point order — which is what decides what a run writes; the
 * landed fill's own field carried the digest of the product's kinds registry,
 * and a stages run reads no kinds registry (the page kinds arrive with the agent
 * stages of 0026).
 *
 * **The inputs a unit's facts stand on.** The declared stages, and then the
 * unit's own reading: the blob the pinned tree holds at the path its scope names,
 * or — where its scope names no path — the commit of the repository it names
 * (`inputsOf`). So a one-file commit inherits every unit whose own bytes did not
 * move, and computes again the units of the file that did, of the folders it
 * stands in and of the repository-wide readings. The resolution stage's units are
 * the one exception, and the module's `inputsOf` says why: their facts stand on
 * the symbols of the files they read, which the wiring cannot name before they
 * run, so their input is the run's pins.
 *
 * **The reads.** Every stage reads through `createStageReadReader`
 * (`src/fill/stage-reads.ts`): the named reads of the eight stages answered from
 * the fill's fact store, the graph-read grammar's own reads
 * (`src/fill/graph-reads.ts`) and a stage's own SQL (the history stage's three
 * queries, through the `fact` view `createStageReadSchema` creates) alike. A read
 * a caller makes inside a transaction it already opened runs on it: the process's
 * owner refuses a second transaction on one connection, and a publication's
 * recheck reads through its own.
 *
 * **What is not wired here.** The facts land where the host lands them: the
 * fill's own fact store in the process's database (`FACT_APPLICATION`,
 * `fact-store.ts`), which is the wiring's own choice by leaving `facts` out. No
 * human-edit guard is wired. The agent stages (8 to 13) are not registered
 * anywhere yet.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { byCodePoint } from '../model/order.js';
import { isRepositoryPath } from '../fill/facts.js';
import { ID_PATTERN } from '../model/schema.js';
import type { FillStageConfigurationRead } from '../fill/config.js';
import { readFillStageConfiguration } from '../fill/config.js';
import type { FactStoreDatabase } from '../fill/fact-store.js';
import type { FillProduct, ProductFillWiring } from '../fill/orchestrator-host.js';
import type { UnitRef } from '../fill/orchestrator.js';
import type { RunSnapshot } from '../fill/orchestrator-store.js';
import type { StageRegistry } from '../fill/registry.js';
import { createGitSnapshotSource, type RepositoryPin, type SnapshotSource } from '../fill/snapshot.js';
import { createStageReadReader, createStageReadSchema } from '../fill/stage-reads.js';
import type { AgentStageWiring } from '../fill/stages/agent-stage.js';
import { createStageRegistry } from '../fill/stages/index.js';
import { sameFolder } from './git.js';
import { hashFillInput } from './fill-runtime.js';
import { readProduct, type ProductIdentity } from './manifest.js';

/** What one product's stages fill is built from. */
export interface StagesFillOptions {
  /** The product's folder: its manifest, the product repository, and its `repos/`. */
  readonly product: string;
  /**
   * The database the run's facts, its units, its reads and its queue live in —
   * the process's one owner (decision 0027). This module reads and writes it
   * through the host; it neither opens nor closes it.
   */
  readonly database: FactStoreDatabase;
  /**
   * The agent the product's units are driven with (decision 0026, "Agents and
   * tools"): where it is named, the agent unit stage is registered beside the eight
   * deterministic stages and a run of this product plans its units. Left out, the
   * fill is the deterministic one, and no unit an agent would have to read is
   * planned — a run with no agent never plans work it cannot run.
   */
  readonly agent?: Omit<AgentStageWiring, 'snapshots'>;
}

/** One product's stages fill: the registry the run derives its stage graph from, and the wiring the host drives it with. */
export interface StagesFill {
  /** The product as the host names it. */
  readonly product: FillProduct;
  /** The eight deterministic stages, registered over this product's own pins. */
  readonly registry: StageRegistry;
  readonly wiring: ProductFillWiring;
}

/**
 * The digest of the stages a registry declares: their ids and versions, one
 * `<id>@<version>` line each, in code point order. It is what a run's
 * `registryHash` names (`RunSnapshot`) and one of the inputs every unit's facts
 * stand on, so a stage whose version moved replaces what it published.
 */
export function declaredStagesDigest(registry: StageRegistry): string {
  return hashFillInput(registry.all().map((stage) => `${stage.id}@${String(stage.version)}`).join('\n'));
}

/**
 * Builds one product's stages fill: reads the product's manifest, registers the
 * eight stages over a source that pins its repositories, and creates the fill's
 * read schema. The product's identity is read here, once, so a product whose
 * manifest does not read is refused before a database is touched; the pins
 * themselves are read when a run plans (`snapshot`, see the module doc).
 */
export async function createStagesFill(options: StagesFillOptions): Promise<StagesFill> {
  const folder = resolve(options.product);
  const identity = readIdentity(folder);
  const product: FillProduct = { name: identity.name, folder };
  // The pins one run stands on: read when the run plans (`snapshot`, which the
  // orchestrator asks for before it asks any stage to plan), and read by every
  // other answer of this wiring, so a run's units, its inputs and its sources
  // name one commit of each repository.
  let pinned: readonly RepositoryPin[] | undefined;
  const pins = (): readonly RepositoryPin[] => (pinned ??= pinsOf(identity));
  const snapshots = createGitSnapshotSource(pins);
  /** Reads the pins again, for the run about to plan (`snapshot`): see the module doc. */
  const repin = (): readonly RepositoryPin[] => (pinned = pinsOf(identity));
  const registry = createStageRegistry({
    snapshots,
    checkoutOf: (repository: string) => rootOf(identity, repository),
    ...(options.agent === undefined ? {} : { agent: options.agent }),
  });
  // The view a stage's own SQL reads through (the history stage's three queries)
  // stands before any run: it is the store's own schema, and no read may create
  // it (a read inside a publication's transaction could not).
  await createStageReadSchema(options.database);
  const wiring: ProductFillWiring = {
    snapshot: () => snapshotOf(identity, registry, repin()),
    configuration: (): FillStageConfigurationRead => readFillStageConfiguration(folder),
    graph: (ref, transaction) => createStageReadReader({
      database: options.database,
      snapshot: snapshots,
      ...(transaction === undefined ? {} : { executor: transaction }),
    }),
    source: (): SnapshotSource => snapshots,
    inputs: (ref) => inputsOf(identity, registry, pins(), ref),
  };
  return { product, registry, wiring };
}

/** The product's identity, refused with the manifest's own file, line and words. */
function readIdentity(folder: string): ProductIdentity {
  const read = readProduct(folder);
  if (!read.ok) throw new Error(`${read.file}:${read.line}: ${read.message}`);
  if (!ID_PATTERN.test(read.product.name)) {
    throw new Error(`the product ${read.product.folder} names itself ${JSON.stringify(read.product.name)}, which is no repository name: a name a repository is read under starts with a letter or a digit and carries letters, digits, ".", "_" or "-" (write "name:" in ${read.product.folder}/workspace.yaml)`);
  }
  return read.product;
}

/**
 * The repositories one run pins, in the manifest's own order: the product
 * repository first, then each code repository the manifest declares. A declared
 * repository whose folder is not a Git checkout is refused by name here, before
 * any stage plans a unit for it.
 */
function pinsOf(identity: ProductIdentity): readonly RepositoryPin[] {
  const pins: RepositoryPin[] = [pinOf(identity.name, 'product', identity.folder)];
  for (const repo of identity.repos) {
    const root = checkoutFolderOf(identity, repo.name);
    pins.push(pinOf(repo.name, 'code', root, repo.branch));
  }
  return pins;
}

/** One repository pinned at the commit its checkout's HEAD names. */
function pinOf(id: string, form: 'code' | 'product', root: string, defaultBranch?: string): RepositoryPin {
  const commit = git(root, id, ['rev-parse', 'HEAD']);
  const branch = defaultBranch ?? branchOf(root, id);
  return { id, form, root, commit, ...(branch === undefined ? {} : { defaultBranch: branch }) };
}

/** The branch one checkout's HEAD stands on; `undefined` where it is detached or the branch cannot be read. */
function branchOf(root: string, id: string): string | undefined {
  const branch = gitQuietly(root, ['symbolic-ref', '--short', 'HEAD']);
  if (branch === undefined || branch === '') return undefined;
  return branch;
}

/**
 * The folder a declared code repository stands in: `<the product>/repos/<name>`.
 * A checkout connected in `link` mode — what `madarch init` and `madarch repo
 * add` do by default — is a symbolic link or a directory junction at that path,
 * and git answers the *physical* folder, so the two are compared as folders and
 * never as text (the project's own rule, `sameFolder` in `src/product/git.ts`).
 */
function checkoutFolderOf(identity: ProductIdentity, name: string): string {
  const root = resolve(identity.folder, 'repos', name);
  const top = gitQuietly(root, ['rev-parse', '--show-toplevel']);
  if (top === undefined || !sameFolder(top, root)) {
    throw new Error(`the product ${identity.folder} declares the repository ${JSON.stringify(name)}, and ${root} is no Git checkout of its own: connect it with "madarch repo add ${name} <url>" or bootstrap the product (madarch bootstrap)`);
  }
  return root;
}



/** The folder one repository's checkout stands in, refused by name where the product pins no such repository. */
function rootOf(identity: ProductIdentity, repository: string): string {
  if (repository === identity.name) return identity.folder;
  const declared = identity.repos.find((repo) => repo.name === repository);
  if (declared === undefined) {
    const known = [identity.name, ...identity.repos.map((repo) => repo.name)].map((id) => JSON.stringify(id));
    throw new Error(`the repository ${JSON.stringify(repository)} is not one the product ${identity.folder} pins: it pins ${known.join(', ')}`);
  }
  return checkoutFolderOf(identity, declared.name);
}

/**
 * The named inputs one unit's facts stand on. A unit's own bytes are what the
 * stages that compare blobs plan by (stages 1, 2, 3, 4 and 6 name a unit per
 * changed blob), so a unit whose scope names a repository path carries the blob
 * the pinned tree holds there: a commit that moved no other file inherits it, and
 * only the unit of the file that moved is computed again.
 *
 * A unit whose scope names no path reads its repository whole — stage 0's
 * snapshot of it, stage 5's clustering of its graph, stage 7's ancestry — so its
 * input is the commit of the repository it names.
 *
 * The resolution stage's units are the exception, and it is deliberate: a
 * resolution unit's facts stand on the symbols of the files it read, which the
 * wiring cannot name before the unit runs, and the stage's plan names the
 * importers of a file that moved (madarch-tzte.21.6). A digest of its own bytes
 * alone would let the orchestrator inherit such an importer's published
 * generation and keep edges that name symbols the new publication no longer
 * holds, so a resolution unit's input is the run's pins: a run on another commit
 * re-resolves the files its plan names.
 */
function inputsOf(_identity: ProductIdentity, registry: StageRegistry, pins: readonly RepositoryPin[], ref: UnitRef): Readonly<Record<string, string>> {
  const inputs: Record<string, string> = { stages: declaredStagesDigest(registry) };
  // An agent unit's facts stand on what it read, and nothing on its scope's own pin (decision 0026,
  // "Updates"): its reads with their membership are rechecked by the orchestrator, the spans it read are
  // rechecked against the run's own pins, and the prompt, schema and model versions it ran under are part
  // of its stage's cache versions. A repository's commit here would replace every unit of every commit and
  // rerun work the change never reached, which is exactly what the update is not. The marker is the stage
  // contract's own: a stage whose units read and write through the unit's MCP server is an agent stage
  // (madarch-tzte.24.1's shape), whatever its id.
  if (registry.get(ref.stageId)?.usesTools === true) return inputs;
  const path = pathOfScope(pins, ref.scope);
  const readsFacts = RESOLUTION_STAGE_ID === ref.stageId;
  if (path !== undefined && !readsFacts) {
    inputs['entry'] = blobOf(pins, repositoryOfScope(pins, ref.scope) ?? '', path);
  } else {
    // A unit whose scope names no path reads one repository whole: the digest of
    // *that* repository's pin, so a commit in one repository of a product with
    // several leaves the others' readings alone.
    inputs['pins'] = onePinDigest(pins, repositoryOfScope(pins, ref.scope));
  }
  return inputs;
}

/** The stage whose units read other units' symbols, whose input is therefore the run's pins (see `inputsOf`). */
const RESOLUTION_STAGE_ID = 'semantic-resolution';

/**
 * The path one unit's scope names, where it names one: the scopes of the stages
 * that read a file are `<repository>:<path>` (the inventory's own form). The
 * modules stage's scope is `<repository>`, and the history stage's is its own
 * `repository:<name>@<commit>` — whose first leg is the word `repository`, so a
 * scope is read as a path only where its first leg is a repository this run pins,
 * the scope is not a history scope, and what follows is a repository path.
 * Anything else names no file, and its unit reads its repository whole.
 */
function pathOfScope(pins: readonly RepositoryPin[], scope: string): string | undefined {
  // The history stage's scope begins with the word `repository` and names a
  // commit, not a file: it is read by its own form and never as a path.
  if (scope.startsWith('repository:')) return undefined;
  const at = scope.indexOf(':');
  if (at < 0) return undefined;
  const repository = scope.slice(0, at);
  const path = scope.slice(at + 1);
  if (!pins.some((pin) => pin.id === repository)) return undefined;
  return isRepositoryPath(path) ? path : undefined;
}

/**
 * The repository one unit's scope reads whole: the repository its scope names —
 * `<repository>` for the snapshot and modules stages, `repository:<name>@<commit>`
 * for the history stage — or `undefined` where the scope names none this run
 * pins (a product whose name is no repository name never reaches here: the pins
 * refuse it). The history scope is read by its own form, so a repository named
 * `repository` cannot be taken for it.
 */
function repositoryOfScope(pins: readonly RepositoryPin[], scope: string): string | undefined {
  const held = pins.map((pin) => pin.id);
  if (held.includes(scope)) return scope;
  if (scope.startsWith('repository:')) {
    const name = scope.slice('repository:'.length).split('@')[0] ?? '';
    if (held.includes(name)) return name;
  }
  const at = scope.indexOf(':');
  const first = at < 0 ? scope : scope.slice(0, at);
  return held.includes(first) ? first : undefined;
}

/**
 * The blob the pinned tree holds at one unit's path, in the repository its scope
 * names — or, where the tree holds no such file (a path the commit no longer
 * holds, a folder, an unfiled name), a token saying so. A blob that moved moves
 * the unit's input; a path that left the tree moves it too, so a retraction is
 * planned and executed rather than inherited.
 */
function blobOf(pins: readonly RepositoryPin[], repository: string, path: string): string {
  const pin = pins.find((candidate) => candidate.id === repository);
  if (pin === undefined) {
    throw new Error(`the unit's scope names the repository ${JSON.stringify(repository)}, which the run does not pin: it pins ${pins.map((candidate) => JSON.stringify(candidate.id)).join(', ')}`);
  }
  const listed = gitQuietly(pin.root, ['ls-tree', '-z', pin.commit, '--', path]);
  if (listed === undefined) return 'no-entry';
  // One tree entry: its mode, its type, its object id and its path.
  const [meta] = listed.split('\u0000');
  const object = (meta ?? '').split(/\s+/)[2];
  return object === undefined || object === '' ? 'no-entry' : object;
}

/**
 * The pinned product snapshot one run stands on, as fill-runtime's own shape
 * holds it: the product repository's own pin, because that is the repository a
 * person fills and the commit the run stands on. The other repositories' commits
 * are the pins themselves (see the module doc).
 */
function snapshotOf(identity: ProductIdentity, registry: StageRegistry, pins: readonly RepositoryPin[]): RunSnapshot {
  const product = pins.find((pin) => pin.form === 'product');
  if (product === undefined) {
    throw new Error(`the product ${identity.folder} pins no product repository, and every run of it stands on one: this is a defect of this module (src/product/fill-stages.ts, pinsOf)`);
  }
  return {
    repository: identity.folder,
    defaultBranch: product.defaultBranch ?? 'HEAD',
    commit: product.commit,
    registryHash: declaredStagesDigest(registry),
  };
}

/**
 * The digest of the run's pins: one `<id>@<commit>` line per repository, in code
 * point order of the ids. A pin whose commit moved moves it, which is what makes
 * a unit's own inputs move.
 */
function pinsDigest(pins: readonly RepositoryPin[]): string {
  return hashFillInput(pins.map((pin) => `${pin.id}@${pin.commit}`).sort(byCodePoint).join('\n'));
}

/**
 * The digest of one repository's pin, where the scope names one this run pins;
 * every pin where it does not (a scope that names no repository of this run is
 * still a unit of it, and the run's whole set is the honest answer then).
 */
function onePinDigest(pins: readonly RepositoryPin[], repository: string | undefined): string {
  if (repository === undefined) return pinsDigest(pins);
  return pinsDigest(pins.filter((pin) => pin.id === repository));
}

/** One read-only Git answer, refused by name where git failed: the repository, the folder and git's own words. */
function git(root: string, id: string, args: readonly string[]): string {
  const answer = gitQuietly(root, args);
  if (answer === undefined) {
    throw new Error(`the repository ${JSON.stringify(id)} of the product stands in ${root}, and git could not read it: "git ${args.join(' ')}" failed there, which is no Git checkout or one git cannot read`);
  }
  return answer;
}

/** One read-only Git answer, `undefined` where git failed or answered nothing. */
function gitQuietly(root: string, args: readonly string[]): string | undefined {
  try {
    const stdout = execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return stdout === '' ? undefined : stdout;
  } catch {
    return undefined;
  }
}
