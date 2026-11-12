/**
 * Product wiring for ordinary declared plugin execution. The host pins repository
 * bytes and configuration once per run; plugins interpret those bytes and publish
 * their declared graph outputs through the same generic publication path.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { byCodePoint } from '../model/order.js';
import { withSpan } from '../obs/trace.js';
import { isRepositoryPath } from '../fill/facts.js';
import type { FillStageConfigurationRead } from './manifest/fill-config.js';
import { assertPluginTurnsEnabled, readFillManifests, fillStageConfigurationFrom } from './manifest/fill-config.js';
import { createOneGraphSchema } from '../graph/one-graph.js';
import { EMPTY_CONTRACT } from '../graph/contract.js';
import { graphContractOf } from '../fill/stages/plugin-contract.js';
import { planManifestFill } from '../plugin/fill-declarations.js';
import type { PluginAgentOptions } from '../plugin/agent.js';
import { publishGraphWrites } from '../graph/claims.js';
import type { FillProduct, ProductFillWiring } from '../fill/orchestrator-host.js';
import type { UnitRef } from '../fill/orchestrator.js';
import type { RunSnapshot } from '../fill/orchestrator-store.js';
import type { StageRegistry } from '../fill/registry.js';
import { createGitSnapshotSource, type RepositoryPin, type SnapshotSource } from '../plugin/repository-snapshot.js';
import { createStageRegistry } from '../fill/stages/index.js';
import { sameFolder } from './git.js';
import { hashFillInput } from './fill-runtime.js';
import { answerPluginGraphQuery, pluginGraphAnswerer } from '../fill/plugin-turns.js';
import type { OuterTransaction } from '../history-types.js';
import { recordAgentUsage, type AgentUsageRecord } from '../adapters/agent-usage.js';
import type { AgentRunBudget } from '../fill/agent-meter.js';
import type { ProductIdentity } from './manifest.js';
import { fillFolderIdentity, productRepositoryId } from './identity.js';
import { headCommitOf } from './fill-updates.js';
import { raise } from '../model/raise.js';
import { validateProductManifests, publishValidatedManifests } from '../graph/manifest-publication.js';
import { withManifestContract } from '../graph/manifest-contract.js';
import { WORKFLOWS_FILE, engineFirstFillStages, firstFillStagesOfFiles, type FirstFillRead } from './manifest/workflows.js';

/**
 * The process's one connection as this wiring names it: the type the graph store
 * is built over. Naming the store's own parameter type keeps this module from
 * importing the connection (decision 0033, item 3: only the graph store and the
 * storage layer import it) while still reading and lending the owner the host
 * created.
 */
type FillDatabase = Parameters<typeof createOneGraphSchema>[0];

/** What one product's stages fill is built from. */
export interface StagesFillOptions {
  /** Run-owned repository preparation; each PluginHost still snapshots its own input bytes. */
  readonly prepareRepositoryInputs?: typeof import('../plugin/repository-input.js').prepareRepositoryInputs;
  /** The owning process prepares the exact pinned contract before any fill client attaches. */
  readonly prepareContract?: (contract: import('../graph/contract.js').GraphContract) => Promise<void>;
  /** The product's folder: its manifest, the product repository, and its `repos/`. */
  readonly product: string;
  /**
   * The database the run's facts, its units, its reads and its queue live in —
   * the process's one owner (decision 0027). This module reads and writes it
   * through the host; it neither opens nor closes it.
   */
  readonly database: FillDatabase;
  /** Repository path prefixes forwarded to ordinary plugin inputs. */
  readonly paths?: readonly string[];
  /**
   * The kinds this run was asked for (madarch-stm0.6, decision 0035 items 11 and 31): their plugin turns only, in this
   * dependency order, and with a vertex the one entity it rewrites. Left out, the run fills every kind the manifest binds
   * a plugin to, as a whole fill does.
   */
  readonly targets?: { readonly kinds: readonly string[]; readonly vertex?: string };
  /** The plugin closures this fill trusts beside the release's. */
  readonly releaseHashes?: readonly string[];
  /** The supervised ACP adapter available to this run's agent plugin turns. */
  readonly pluginAgent?: PluginAgentOptions;
  /**
   * The run's id, which a run's trace and its metered agent spend are named by (madarch-stm0.4). Left out, the run has
   * no id yet and no spend of its own to record: a caller that drives the stages without `runFill` names none.
   */
  readonly runId?: string;
  /** The budget explicitly supplied for this run, never a saved catalogue selection. */
  readonly budget?: AgentRunBudget;
}

/** One product's stages fill: the registry the run derives its stage graph from, and the wiring the host drives it with. */
export interface StagesFill {
  /** The product as the host names it. */
  readonly product: FillProduct;
  /** The ordinary plugin stage, registered over this product's own declarations. */
  readonly registry: StageRegistry;
  readonly wiring: ProductFillWiring;
  /** The graph kinds the product's contract declared (false when it declares none). */
  readonly kinds: false | { readonly vertex: readonly string[]; readonly edge: readonly string[] } | undefined;
  /**
   * The declared repositories this run could not pin, each with its path and the state it is
   * in: a checkout that holds no commit yet. A run reads the repositories it can and says what
   * it did for these, rather than refusing the product.
   */
  readonly unread: () => readonly UnreadRepository[];
}

/**
 * The digest of the stages a registry declares: their ids and versions, one
 * `<id>@<version>` line each, in code point order. It is what a run's
 * `registryHash` names (`RunSnapshot`) and one of the inputs every unit's facts
 * stand on, so a stage whose version moved replaces what it published.
 */
function declaredStagesDigest(registry: StageRegistry): string {
  return hashFillInput(registry.all().map((stage) => `${stage.id}@${String(stage.version)}`).join('\n'));
}

/**
 * Builds one product's stages fill: reads the product's manifest, registers the
 * eight stages over a source that pins its repositories, and creates the fill's
 * read schema. The product's identity is read here, once, so a product whose
 * manifest does not read is refused before a database is touched; the pins
 * themselves are read when a run plans (`snapshot`, see the module doc).
 */
/** Resolve the graph contract from the same pinned Git tree a fill reads, before clients start. */
export async function readPinnedGraphContract(product: string): Promise<import('../graph/contract.js').GraphContract> {
  const folder = resolve(product);
  const read = fillFolderIdentity(folder);
  const pins = pinsOf(read.identity, read.product).pins;
  const snapshots = createGitSnapshotSource(() => pins);
  const own = await snapshots.open(productRepositoryId(read.identity));
  const { kindsRead: kinds } = await readFillManifests(own, folder);
  return kinds.present ? graphContractOf(kinds.manifest) : EMPTY_CONTRACT;
}

export async function createStagesFill(options: StagesFillOptions): Promise<StagesFill> {
  const folder = resolve(options.product);
  const read = await withSpan('fill.identity', { 'madarch.product': folder }, async () => fillFolderIdentity(folder));
  const identity = read.identity;
  const product: FillProduct = { name: identity.name, folder };
  // The pins one run stands on: read when the run plans (`snapshot`, which the
  // orchestrator asks for before it asks any stage to plan), and read by every
  // other answer of this wiring, so a run's units, its inputs and its sources
  // name one commit of each repository.
  let pinned: readonly RepositoryPin[] | undefined;
  let unread: readonly UnreadRepository[] = [];
  const readPins = (): readonly RepositoryPin[] => {
    const pinnedRead = pinsOf(identity, read.product);
    unread = pinnedRead.unread;
    return (pinned = pinnedRead.pins);
  };
  const pins = (): readonly RepositoryPin[] => pinned ?? readPins();
  const snapshots = createGitSnapshotSource(pins);
  /** Reads the pins again, for the run about to plan (`snapshot`): see the module doc. */
  const repin = (): readonly RepositoryPin[] => readPins();
  // The product's own declaration files as the commit this run pins holds them: the fill reads the tree it stores, never
  // the working tree beside it, so the graph and the run agree byte for byte (madarch-hsqs stage C).
  const { files, kindsRead, lockRead } = await withSpan('fill.product-files', { 'madarch.product': identity.name }, async () => {
    const own = await snapshots.open(productRepositoryId(identity));
    return readFillManifests(own, folder);
  });
  if (kindsRead.present) {
    const plan = planManifestFill(kindsRead.manifest, folder, options.targets?.kinds, options.pluginAgent !== undefined);
    assertPluginTurnsEnabled(plan.order, files.has(WORKFLOWS_FILE) ? firstFillStagesOfFiles(files, folder) : engineFirstFillStages(), fillStageConfigurationFrom(files, folder));
  }
  const locks = new Map(lockRead.ok ? lockRead.entries.map((entry) => [entry.id, entry] as const) : []);
  // Each plugin declares its own bounds; a caller may supply a budget for this run.
  const budget = options.budget;
  const declaredBounds = [...(kindsRead.present ? kindsRead.manifest.plugins?.values() ?? [] : [])].filter((plugin) => plugin.bounds !== undefined).sort((left, right) => byCodePoint(left.id, right.id));
  if (options.runId !== undefined) {
    await withSpan('agent.bounds', {
      'agent.run': options.runId,
      ...Object.fromEntries(declaredBounds.flatMap((plugin) => [
        ...(plugin.bounds?.tokens === undefined ? [] : [[`agent.plugin.${plugin.id}.tokens`, plugin.bounds.tokens] as const]),
        ...(plugin.bounds?.cost === undefined ? [] : [[`agent.plugin.${plugin.id}.cost`, plugin.bounds.cost.amount] as const, [`agent.plugin.${plugin.id}.currency`, plugin.bounds.cost.currency] as const]),
      ])),
    }, async () => undefined);
  }
  const agentUsage = options.runId === undefined ? undefined : {
    run: options.runId,
    ...(budget === undefined ? {} : { budget }),
    save: async (rows: readonly AgentUsageRecord[]) => await recordAgentUsage(options.database, rows),
  };
  const contract = kindsRead.present ? graphContractOf(kindsRead.manifest) : EMPTY_CONTRACT;
  // Only the product's declarations introduce graph kinds.
  const kinds = contract.vertex.length === 0 && contract.edge.length === 0 ? false : { vertex: contract.vertex.map((kind) => kind.name), edge: contract.edge.map((kind) => kind.name) };
  const metadata = read.product ? validateProductManifests(folder, files, pins().find((one) => one.id === productRepositoryId(identity))?.commit) : undefined;
  if (metadata !== undefined && !metadata.ok) throw new Error(metadata.findings.map((one) => `${one.file}:${one.line}: ${one.message}`).join('\n'));
  if (options.prepareContract !== undefined) await options.prepareContract(withManifestContract(contract));
  await createOneGraphSchema(options.database, withManifestContract(contract));
  if (metadata?.ok && metadata.value !== undefined) await publishValidatedManifests(options.database, metadata.value);
  // Building the registry loads the stages' own modules and their parsers: one span names what that cost.
  const registry = await withSpan('fill.registry', { 'madarch.product': identity.name }, async (span) => {
    const held = createStageRegistry({
      // The product's plugins and the graph their turns read (decision 0035, items 15 and 20): the lock names the exact
      // version and closure, the manifest names the kinds and documents, and the store is where the file units stand.
      ...(kindsRead.present && (kindsRead.manifest.plugins?.size ?? 0) > 0
        ? { plugins: { ...(options.pluginAgent === undefined ? {} : { agent: options.pluginAgent }), productFolder: folder, manifest: kindsRead.manifest, locks, owner: options.database, snapshots, ...(options.prepareRepositoryInputs === undefined ? {} : { prepareRepositoryInputs: options.prepareRepositoryInputs }), contract, ...(options.paths === undefined ? {} : { paths: options.paths }), ...(options.releaseHashes === undefined ? {} : { releaseHashes: options.releaseHashes }), ...(options.targets === undefined ? {} : { targets: options.targets }), ...(kindsRead.manifest.journal?.debug === true ? { debug: true } : {}), ...(process.env['MADARCH_PLUGIN_CGROUP'] === undefined ? {} : { cgroupParent: process.env['MADARCH_PLUGIN_CGROUP'] }), ...(agentUsage === undefined ? {} : { agentUsage }) } }
        : {}),
    });
    span.setAttribute('madarch.stages', held.all().length);
    return held;
  });
  // The stages a run of this product enables are its workflow's (decision 0033, item 2): a product that
  // holds no manifest of its own runs the engine's starter set, as a repository that is no product does.
  // A product that holds no workflows manifest runs the engine's starter set, as a repository that is no product does.
  const workflow = files.has(WORKFLOWS_FILE) ? firstFillStagesOfFiles(files, folder) : engineFirstFillStages();
  const wiring: ProductFillWiring = {
    snapshot: () => ({ ...snapshotOf(identity, registry, repin()), ...(options.targets === undefined ? {} : { targets: options.targets }) }),
    configuration: (): FillStageConfigurationRead => configurationOfWorkflow(workflow, fillStageConfigurationFrom(files, folder), registry),
    // Plugin reads use the orchestrator's recorder and replay inside the publication's transaction.
    graph: (_ref, transaction) => {
      const owner: FillDatabase = transaction === undefined ? options.database : {
        ...options.database,
        transaction: async (_kind, work) => await work(transaction as OuterTransaction),
        run: async (work) => await work(transaction as OuterTransaction),
      };
      const answerer = kindsRead.present ? pluginGraphAnswerer({ owner, manifest: kindsRead.manifest, contract }) : undefined;
      return { query: async (text) => {
        if (answerer === undefined) throw new Error('src/product/fill-stages.ts:1: plugin graph reads require the product kind declarations');
        return await answerPluginGraphQuery(answerer, text);
      } };
    },
    source: (): SnapshotSource => snapshots,
    // A plugin's answer publishes as the graph's claims inside the publication's own transaction (decision 0035, item 6).
    facts: { apply: async ({ executor, writes }) => await publishGraphWrites(executor, contract, writes) },
    inputs: (ref) => inputsOf(registry, pins(), ref),
  };
  return { product, registry, wiring, kinds, unread: () => unread };
}

/**
 * What a run enables, as the orchestrator's configuration read (decision 0027):
 * the product's `fill.stages` entries as it wrote them, and every stage the
 * run's workflow does not name turned off (decision 0033, item 2: which stages a
 * run enables is its workflow's). A stage the product wrote a broken entry for is
 * passed on as written, so the registry names the fault instead of this reader
 * dropping it; a stage the workflow does not name keeps the product's other
 * fields and is disabled.
 */
function configurationOfWorkflow(workflow: FirstFillRead, written: FillStageConfigurationRead, registry: StageRegistry): FillStageConfigurationRead {
  if (!workflow.ok) {
    return { ok: false, errors: [{ file: workflow.refusal.file, line: workflow.refusal.line, path: '', message: workflow.refusal.message }] };
  }
  if (!written.ok) return written;
  const named = new Set(workflow.stages);
  const stages: Record<string, unknown> = Object.create(null);
  for (const stage of registry.all()) {
    const held = Object.prototype.hasOwnProperty.call(written.stages, stage.id) ? written.stages[stage.id] : undefined;
    const object = held !== null && typeof held === 'object' && !Array.isArray(held) ? held as Record<string, unknown> : undefined;
    if (object !== undefined) {
      stages[stage.id] = { ...object, enabled: named.has(stage.id) ? object['enabled'] ?? true : false };
      continue;
    }
    if (held !== undefined) {
      stages[stage.id] = held;
      continue;
    }
    if (!named.has(stage.id)) stages[stage.id] = { enabled: false };
  }
  return { ok: true, file: workflow.file, stages, lines: { ...written.lines } };
}

/** A repository a run could not pin, named where it stands: what the fill did for it, in words. */
export interface UnreadRepository {
  readonly repository: string;
  /** The checkout's full path. */
  readonly path: string;
  /** Why nothing was read of it: the state it is in, never a guess. */
  readonly reason: string;
}

/** What one run pins: the repositories it reads, and the ones it could not pin. */
interface PinnedRepositories {
  readonly pins: readonly RepositoryPin[];
  readonly unread: readonly UnreadRepository[];
}

/**
 * The repositories one run pins, in the manifest's own order: the product
 * repository first, then each code repository the manifest declares. A declared
 * repository whose folder is not a Git checkout is refused by name here, before
 * any stage plans a unit for it; a checkout that holds no commit yet is not a
 * refusal — it is named in `unread`, the run reads the other repositories, and
 * the answer says what it did for it (a repository added before its first
 * commit must not break the product's wiki).
 */
function pinsOf(identity: ProductIdentity, product: boolean): PinnedRepositories {
  // A store names one repository by one id, and two checkouts that share a name are two
  // repositories. The id of the product's own repository is decided in one place, which the fill,
  // the wiring that resolves a unit's folder and the MCP server all read (`productRepositoryId`).
  const own = productRepositoryId(identity);
  const pins: RepositoryPin[] = [pinOf(own, product ? 'product' : 'code', identity.folder)];
  const unread: UnreadRepository[] = [];
  for (const repo of identity.repos) {
    const root = checkoutFolderOf(identity, repo.name);
    if (headCommitOf(root) === undefined) {
      unread.push({ repository: repo.name, path: root, reason: 'the checkout holds no commit yet' });
      continue;
    }
    pins.push(pinOf(repo.name, 'code', root, repo.branch));
  }
  return { pins, unread };
}

/** One repository pinned at the commit its checkout's HEAD names. */
function pinOf(id: string, form: 'code' | 'product', root: string, defaultBranch?: string): RepositoryPin {
  const commit = git(root, id, ['rev-parse', 'HEAD']);
  const branch = defaultBranch ?? branchOf(root, id);
  return { id, form, root, commit, ...(branch === undefined ? {} : { defaultBranch: branch }) };
}

/** The branch one checkout's HEAD stands on; `undefined` where it is detached or the branch cannot be read. */
function branchOf(root: string, _id: string): string | undefined {
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
    raise(`the product ${identity.folder} declares the repository ${JSON.stringify(name)}, and ${root} is no Git checkout of its own: connect it with "madarch repo add ${name} <url>" or bootstrap the product`);
  }
  return root;
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
async function inputsOf(registry: StageRegistry, pins: readonly RepositoryPin[], ref: UnitRef): Promise<Readonly<Record<string, string>>> {
  const inputs: Record<string, string> = { stages: declaredStagesDigest(registry) };
  const path = pathOfScope(pins, ref.scope);
  if (path !== undefined) {
    const repository = repositoryOfScope(pins, ref.scope) ?? '';
    inputs['entry'] = blobOf(pins, repository, path);
  } else {
    // A unit whose scope names no path reads one repository whole: the digest of
    // *that* repository's pin, so a commit in one repository of a product with
    // several leaves the others' readings alone.
    inputs['pins'] = onePinDigest(pins, repositoryOfScope(pins, ref.scope));
  }
  return inputs;
}

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
  // The folder a fill was asked for is the commit the run stands on: its own repository's pin, whether the folder is a
  // product repository or a checkout that is no product.
  const own = pins.find((pin) => pin.form === 'product') ?? pins[0];
  if (own === undefined) {
    throw new Error(`the folder ${identity.folder} pins no repository, and every run stands on one: this is a defect of this module (src/product/fill-stages.ts, pinsOf)`);
  }
  return {
    repository: identity.folder,
    defaultBranch: own.defaultBranch ?? 'HEAD',
    commit: own.commit,
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
    raise(`the repository ${JSON.stringify(id)} of the product stands in ${root}, and git could not read it: "git ${args.join(' ')}" failed there, which is no Git checkout or one git cannot read`);
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
