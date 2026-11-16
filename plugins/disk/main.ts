import { createHash } from 'node:crypto';
import type { ExtractContext, Unit, UnitResult, VertexResult, EdgeResult } from 'madarch-plugin-sdk';
import { classOfPath, excludedPath, readRepositoryTree, type FileClassRule, type RepositoryAt } from './reader.js';

/** Reads pinned objects itself; the host supplies only read-only mounts and pin metadata. */
export async function extract(unit: Unit, context: ExtractContext): Promise<UnitResult> {
  const inputs = unit.inputs as { repositories: readonly RepositoryAt[]; edgeOutputs: readonly { kind: string; from: string; to: string }[]; contract: { vertices: readonly { kind: string; fields: readonly { name: string }[] }[]; edges: readonly { kind: string }[] }; paths?: readonly string[]; keys?: readonly { repository: string; path: string }[]; classRules?: readonly FileClassRule[]; exclude?: readonly string[] };
  if (!Array.isArray(inputs?.repositories)) throw new Error('disk needs pinned repository inputs');
  const vertices: VertexResult[] = [], edges: EdgeResult[] = [], problems: string[] = [], snapshots: { digest: string; content: string; about: import('madarch-plugin-sdk').EntityRef[] }[] = [];
  for (const pin of inputs.repositories) {
    if (context.signal.aborted) throw new Error('disk extraction cancelled');
    const tree = await readRepositoryTree(pin, { fileFacts: unit.kind === 'code.file', ...(inputs.keys === undefined ? {} : { paths: inputs.keys.filter(key => key.repository === pin.repository).map(key => key.path) }) });
    const repository = { kind: 'code.repository', key: { name: pin.repository } };
    const inventory = [...tree.files.map(file => [file.path, file.blob]), ...tree.gitlinks.map(link => [link.path, link.commit])].sort((left, right) => left[0]! < right[0]! ? -1 : left[0]! > right[0]! ? 1 : 0);
    const treeSnapshot = tree.gaps.length === 0 && inputs.keys === undefined && inputs.paths === undefined ? createHash('sha256').update(JSON.stringify(inventory)).digest('hex') : undefined;
    const inventoryContent = JSON.stringify(inventory);
    const inventoryDigest = createHash('sha256').update(inventoryContent).digest('hex');
    const inventoryTarget = { kind: 'code.blob', key: { digest: inventoryDigest } };
    snapshots.push({ digest: inventoryDigest, content: inventoryContent, about: [repository] });
    const evidence = { target: inventoryTarget, commit: pin.commit };
    vertices.push({ ...repository, values: { url: tree.repository.url, default_branch: pin.defaultBranch ?? null, ...(treeSnapshot === undefined ? {} : { tree_snapshot: treeSnapshot }) }, evidence });
    const folders = new Set<string>();
    const within = (path: string): boolean => inputs.paths === undefined || inputs.paths.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
    // The product's own exclusions: a repository's node_modules or build output is not the product's knowledge unless the
    // catalogue says it is (madarch-64o5.83).
    for (const file of tree.files.filter(file => within(file.path) && !excludedPath(file.path, inputs.exclude ?? []))) {
      const entity = { kind: 'code.file', key: { path: file.path }, keyEdges: { 'code.file-repository': repository } };
      const content = file.content;
      const fileDigest = content === null ? undefined : createHash('sha256').update(content).digest('hex');
      if (fileDigest !== undefined) snapshots.push({ digest: fileDigest, content: content!, about: [entity] });
      const fileEvidence = { target: fileDigest === undefined ? inventoryTarget : { kind: 'code.blob', key: { digest: fileDigest } }, commit: pin.commit, path: file.path };
      const fileClass = classOfPath(file.path, inputs.classRules ?? []);
      vertices.push({ ...entity, values: { mode: file.mode, blob: file.blob, bytes: file.bytes, form: file.form, lines: file.lines, content: file.content, language: file.language, languages: file.candidates, ...(fileClass === undefined ? {} : { class: fileClass }) }, evidence: fileEvidence });
      const parent = file.path.includes('/') ? { kind: 'code.directory', key: { path: file.path.slice(0, file.path.lastIndexOf('/')) }, keyEdges: { 'code.directory-repository': repository } } : repository;
      edges.push({ kind: 'code.contains', from: parent, to: entity, evidence });
      if (parent.kind === 'code.directory') edges.push({ kind: 'code.file-directory', from: entity, to: parent, evidence });
      let folder = file.path.slice(0, file.path.lastIndexOf('/'));
      if (!file.path.includes('/')) folder = '';
      while (folder !== '') { folders.add(folder); const at = folder.lastIndexOf('/'); folder = at < 0 ? '' : folder.slice(0, at); }
    }
    for (const link of tree.gitlinks.filter(link => within(link.path) && !excludedPath(link.path, inputs.exclude ?? []))) {
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
  const support = snapshots.filter(snapshot => selectedVertices.some(vertex => vertex.evidence?.target.key['digest'] === snapshot.digest) || selectedEdges.some(edge => edge.evidence?.target.key['digest'] === snapshot.digest));
  return { vertices: [...new Map(support.map(snapshot => [snapshot.digest, { kind: 'code.blob', key: { digest: snapshot.digest }, values: { content: snapshot.content } }])).values(), ...selectedVertices], edges: [...support.flatMap(snapshot => snapshot.about.map(to => ({ kind: 'code.blob-about', from: { kind: 'code.blob', key: { digest: snapshot.digest } }, to }))), ...selectedEdges], end: problems.length ? { state: 'partial', cause: problems.join('\n') } : { state: 'complete' } };
}
