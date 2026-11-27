import { createHash } from 'node:crypto';
import type { ExtractContext, Unit, UnitResult, VertexResult, EdgeResult } from 'madarch-plugin-sdk';
import { classOfPath, readRepositoryTree, type FileClassRule, type RepositoryAt } from './reader.js';

/**
 * How long a pass over a repository's files may run before it hands the loop back: the host stops a plugin that stays
 * silent past its heartbeat deadline, and a whole tree's facts are built one file at a time with no request in between
 * (madarch-64o5.74). The work does not change; only where it yields.
 */
const LOOP_YIELD_MS = 20;
async function yieldToLoop(): Promise<void> {
  await new Promise<void>((done) => setTimeout(done, 0));
}

/** Reads pinned objects itself; the host supplies only read-only mounts and pin metadata. */
export async function extract(unit: Unit, context: ExtractContext): Promise<UnitResult> {
  const inputs = unit.inputs as { repositories: readonly RepositoryAt[]; edgeOutputs: readonly { kind: string; from: string; to: string }[]; contract: { vertices: readonly { kind: string; fields: readonly { name: string }[]; keyEdges?: readonly { role: string }[] }[]; edges: readonly { kind: string }[] }; declaredKeyEdges?: Readonly<Record<string, readonly string[]>>; paths?: readonly string[]; keys?: readonly { repository?: string; path: string }[]; classRules?: readonly FileClassRule[]; exclude?: readonly string[]; product?: { kind: string; key: Record<string, string | number | boolean> }; productRepository?: string };
  if (!Array.isArray(inputs?.repositories)) throw new Error('disk needs pinned repository inputs');
  const vertices: VertexResult[] = [], edges: EdgeResult[] = [], problems: string[] = [], snapshots: { digest: string; content: string; about: import('madarch-plugin-sdk').EntityRef[] }[] = [];
  // A narrowed product declares only the kinds it holds; the immutable blob is its evidence support, and the selected
  // contract says whether it is installed. Evidence itself always stands on that snapshot (0039, item 31).
  const blobs = inputs.contract.vertices.some(vertex => vertex.kind === 'code.blob');
  for (const pin of inputs.repositories) {
    if (context.signal.aborted) throw new Error('disk extraction cancelled');
    // A partitioned key is the kind's own key: after 0039 the repository is the key edge, not a field of the key, so a
    // key that names no repository belongs to every pinned repository and the tree read decides which one holds it.
    const wanted = inputs.keys === undefined ? undefined : [...new Set(inputs.keys.filter(key => key.repository === undefined || key.repository === pin.repository).map(key => key.path))];
    // The declared knowledge narrows the read itself: a key, the fill's paths, and the product's own exclusions are
    // settled before any file's bytes are fetched, so a whole tree costs what its published knowledge costs
    // (madarch-64o5.74; the owner's exclusions, madarch-64o5.83).
    const tree = await readRepositoryTree(pin, {
      fileFacts: unit.kind === 'code.file',
      ...(wanted === undefined ? {} : { paths: wanted }),
      ...(inputs.paths === undefined ? {} : { scope: inputs.paths }),
      ...(inputs.exclude === undefined ? {} : { exclude: inputs.exclude }),
    });
    const repository = { kind: 'code.repository', key: { name: pin.repository } };
    const inventory = tree.inventory;
    const treeSnapshot = tree.gaps.length === 0 && inputs.keys === undefined && inputs.paths === undefined ? createHash('sha256').update(JSON.stringify(inventory)).digest('hex') : undefined;
    const inventoryContent = JSON.stringify(inventory);
    const inventoryDigest = createHash('sha256').update(inventoryContent).digest('hex');
    const inventoryTarget = { kind: 'code.blob', key: { digest: inventoryDigest } };
    snapshots.push({ digest: inventoryDigest, content: inventoryContent, about: [repository] });
    const evidence = { target: inventoryTarget, commit: pin.commit };
    vertices.push({ ...repository, values: { url: tree.repository.url, default_branch: pin.defaultBranch ?? null, ...(treeSnapshot === undefined ? {} : { tree_snapshot: treeSnapshot }) }, evidence });
    // The product that pinned this repository refers to it (0039, item 1): the host names the product's own vertex, and
    // the edge carries the same inventory evidence as the vertex it ends at. A product with no home kind is named here
    // by nothing, and the product's own checkout is no repository it uses, so neither states an edge.
    if (inputs.product !== undefined && pin.repository !== inputs.productRepository) edges.push({ kind: 'product.uses-repository', from: inputs.product, to: repository, evidence });
    const folders = new Set<string>();
    // The reader narrowed the tree by the fill's paths and the product's own exclusions (madarch-64o5.83): every file it
    // answered is one the product publishes, and the long pass over them hands the loop back as it goes.
    let lastYield = Date.now();
    for (const file of tree.files) {
      if (Date.now() - lastYield >= LOOP_YIELD_MS) { await yieldToLoop(); lastYield = Date.now(); }
      const entity = { kind: 'code.file', key: { path: file.path }, keyEdges: { 'code.file-repository': repository } };
      const content = file.content;
      const fileDigest = content === null ? undefined : createHash('sha256').update(content).digest('hex');
      if (fileDigest !== undefined) snapshots.push({ digest: fileDigest, content: content!, about: [entity] });
      const fileEvidence = { target: fileDigest === undefined ? inventoryTarget : { kind: 'code.blob', key: { digest: fileDigest } }, commit: pin.commit, path: file.path };
      const fileClass = classOfPath(file.path, inputs.classRules ?? []);
      vertices.push({ ...entity, values: { mode: file.mode, blob: file.blob, bytes: file.bytes, form: file.form, lines: file.lines, language: file.language, languages: file.candidates, ...(fileClass === undefined ? {} : { class: fileClass }) }, evidence: fileEvidence });
      const parent = file.path.includes('/') ? { kind: 'code.directory', key: { path: file.path.slice(0, file.path.lastIndexOf('/')) }, keyEdges: { 'code.directory-repository': repository } } : repository;
      edges.push({ kind: 'code.contains', from: parent, to: entity, evidence });
      if (parent.kind === 'code.directory') edges.push({ kind: 'code.file-directory', from: entity, to: parent, evidence });
      let folder = file.path.slice(0, file.path.lastIndexOf('/'));
      if (!file.path.includes('/')) folder = '';
      while (folder !== '') { folders.add(folder); const at = folder.lastIndexOf('/'); folder = at < 0 ? '' : folder.slice(0, at); }
    }
    for (const link of tree.gitlinks) {
      const entity = { kind: 'code.gitlink', key: { path: link.path }, keyEdges: { 'code.gitlink-repository': repository } };
      vertices.push({ ...entity, values: { commit_hash: link.commit }, evidence: { ...evidence, path: link.path } });
      const target = inputs.repositories.find(candidate => candidate.url === link.otherRepository);
      if (target === undefined) problems.push(`${pin.repository}/${link.path}:1: submodule origin ${link.otherRepository} has no declared repository endpoint`);
      else edges.push({ kind: 'code.gitlink-other-repository', from: entity, to: { kind: 'code.repository', key: { name: target.repository } }, evidence: { ...evidence, path: link.path } });
      let folder = link.path.includes('/') ? link.path.slice(0, link.path.lastIndexOf('/')) : '';
      edges.push({ kind: 'code.contains', from: folder === '' ? repository : { kind: 'code.directory', key: { path: folder }, keyEdges: { 'code.directory-repository': repository } }, to: entity, evidence });
      while (folder !== '') { folders.add(folder); const at = folder.lastIndexOf('/'); folder = at < 0 ? '' : folder.slice(0, at); }
    }
    for (const path of [...folders].sort()) {
      const entity = { kind: 'code.directory', key: { path }, keyEdges: { 'code.directory-repository': repository } };
      vertices.push({ ...entity, evidence: { ...evidence, path } });
      const parent = path.includes('/') ? { kind: 'code.directory', key: { path: path.slice(0, path.lastIndexOf('/')) }, keyEdges: { 'code.directory-repository': repository } } : repository;
      edges.push({ kind: 'code.contains', from: parent, to: entity, evidence });
    }
    for (const gap of tree.gaps) problems.push(`${pin.repository}: ${gap.what}: ${gap.reason}`);
    context.progress(vertices.length, undefined, pin.repository);
  }
  const output = inputs.contract.vertices.find(vertex => vertex.kind === unit.kind);
  if (output === undefined) throw new Error(`no selected output contract for ${unit.kind}`);
  const fields = new Set(output.fields.map(field => field.name));
  const selectedVertices = vertices.filter(vertex => vertex.kind === unit.kind).map(vertex => ({ ...vertex, ...(vertex.values === undefined ? {} : { values: Object.fromEntries(Object.entries(vertex.values).filter(([field]) => fields.has(field))) }) }));
  const edgeOutputs = new Set(inputs.edgeOutputs.map(edge => JSON.stringify([edge.kind, edge.from, edge.to])));
  const selectedEdges = edges.filter(edge => edgeOutputs.has(JSON.stringify([edge.kind, edge.from.kind, edge.to.kind])));
  // A narrowed product declares only the kinds it holds: support (an immutable blob and its about edges) is published
  // only where the selected contract and edge outputs declare it, never because the plugin's own contract knows it.
  const declaredEdges = new Set(inputs.contract.edges.map(edge => edge.kind));
  const support = blobs
    ? snapshots.filter(snapshot => selectedVertices.some(vertex => vertex.evidence?.target.key['digest'] === snapshot.digest) || selectedEdges.some(edge => edge.evidence?.target.key['digest'] === snapshot.digest))
    : [];
  // The repository owner republishes this pair; non-owners must not publish partial inventories.
  const supportEdges = declaredEdges.has('code.blob-about')
    ? support.flatMap(snapshot => snapshot.about.filter(to => to.kind !== 'code.repository' || unit.kind === 'code.repository').map(to => ({ kind: 'code.blob-about', from: { kind: 'code.blob', key: { digest: snapshot.digest } }, to })))
    : [];
  // A parent role is the product's declaration too: after 0039 the reference is a key edge, and a narrowed product that
  // holds no such edge publishes an entity keyed by its own fields alone.
  type Keyed = { kind: string; key: Record<string, unknown>; keyEdges?: Record<string, import('madarch-plugin-sdk').EntityRef> };
  const pruned = <T extends Keyed>(entity: T): T => {
    if (entity.keyEdges === undefined) return entity;
    // The host states the product's key-edge roles for every kind a fact reaches; a caller that states none keeps the
    // plugin's own contract, which is the direct-call shape of this extraction.
    const roles = inputs.declaredKeyEdges !== undefined
      ? inputs.declaredKeyEdges[entity.kind]
      : inputs.contract.vertices.find(vertex => vertex.kind === entity.kind)?.keyEdges?.map(edge => edge.role);
    if (roles === undefined) return entity;
    const kept = Object.fromEntries(Object.entries(entity.keyEdges).filter(([role]) => roles.includes(role)).map(([role, parent]) => [role, pruned(parent)]));
    const { keyEdges: _dropped, ...rest } = entity;
    return (Object.keys(kept).length === 0 ? rest : { ...rest, keyEdges: kept }) as T;
  };
  const fact = <T>(held: T): T => {
    const record = held as Record<string, unknown>;
    const evidence = record['evidence'] as { target?: Keyed } | undefined;
    return {
      ...record,
      ...(record['from'] === undefined ? {} : { from: pruned(record['from'] as Keyed) }),
      ...(record['to'] === undefined ? {} : { to: pruned(record['to'] as Keyed) }),
      ...(evidence?.target === undefined ? {} : { evidence: { ...evidence, target: pruned(evidence.target) } }),
    } as T;
  };
  return {
    vertices: [...new Map(support.map(snapshot => [snapshot.digest, { kind: 'code.blob', key: { digest: snapshot.digest }, values: { content: snapshot.content } }])).values(), ...selectedVertices].map(vertex => fact(pruned(vertex))),
    edges: [...supportEdges, ...selectedEdges].map(edge => fact(edge)),
    end: problems.length ? { state: 'partial', cause: problems.join('\n') } : { state: 'complete' },
  };
}
