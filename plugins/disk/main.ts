import type { ExtractContext, Unit, UnitResult, VertexResult, EdgeResult } from 'madarch-plugin-sdk';
import { readRepositoryTree, type RepositoryAt } from './reader.js';

/** Reads pinned objects itself; the host supplies only read-only mounts and pin metadata. */
export async function extract(unit: Unit, context: ExtractContext): Promise<UnitResult> {
  const inputs = unit.inputs as { repositories: readonly RepositoryAt[]; edgeOutputs: readonly { kind: string; from: string; to: string }[]; contract: { vertices: readonly { kind: string; fields: readonly { name: string }[] }[]; edges: readonly { kind: string }[] }; paths?: readonly string[] };
  if (!Array.isArray(inputs?.repositories)) throw new Error('disk needs pinned repository inputs');
  const vertices: VertexResult[] = [], edges: EdgeResult[] = [], problems: string[] = [];
  for (const pin of inputs.repositories) {
    if (context.signal.aborted) throw new Error('disk extraction cancelled');
    const tree = await readRepositoryTree(pin);
    const evidence = { repository: pin.repository, commitOrDigest: pin.commit };
    const repository = { kind: 'code.repository', key: { name: pin.repository } };
    vertices.push({ ...repository, values: { url: tree.repository.url, default_branch: pin.defaultBranch ?? null }, evidence });
    const folders = new Set<string>();
    const within = (path: string): boolean => inputs.paths === undefined || inputs.paths.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
    for (const file of tree.files.filter(file => within(file.path))) {
      const entity = { kind: 'code.file', key: { repository: pin.repository, path: file.path } };
      vertices.push({ ...entity, values: { mode: file.mode, blob: file.blob, bytes: file.bytes, form: file.form, lines: file.lines, content: file.content, language: file.language, languages: file.candidates }, evidence: { ...evidence, path: file.path } });
      const parent = file.path.includes('/') ? { kind: 'code.directory', key: { repository: pin.repository, path: file.path.slice(0, file.path.lastIndexOf('/')) } } : repository;
      edges.push({ kind: 'code.contains', from: parent, to: entity, evidence });
      let folder = file.path.slice(0, file.path.lastIndexOf('/'));
      if (!file.path.includes('/')) folder = '';
      while (folder !== '') { folders.add(folder); const at = folder.lastIndexOf('/'); folder = at < 0 ? '' : folder.slice(0, at); }
    }
    for (const link of tree.gitlinks.filter(link => within(link.path))) {
      const entity = { kind: 'code.gitlink', key: { repository: pin.repository, path: link.path } };
      vertices.push({ ...entity, values: { other_repository: link.otherRepository, commit_hash: link.commit }, evidence: { ...evidence, path: link.path } });
      let folder = link.path.includes('/') ? link.path.slice(0, link.path.lastIndexOf('/')) : '';
      edges.push({ kind: 'code.contains', from: folder === '' ? repository : { kind: 'code.directory', key: { repository: pin.repository, path: folder } }, to: entity, evidence });
      while (folder !== '') { folders.add(folder); const at = folder.lastIndexOf('/'); folder = at < 0 ? '' : folder.slice(0, at); }
    }
    for (const path of [...folders].sort()) {
      const entity = { kind: 'code.directory', key: { repository: pin.repository, path } };
      vertices.push({ ...entity, evidence: { ...evidence, path } });
      const parent = path.includes('/') ? { kind: 'code.directory', key: { repository: pin.repository, path: path.slice(0, path.lastIndexOf('/')) } } : repository;
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
  return { vertices: selectedVertices, edges: selectedEdges, end: problems.length ? { state: 'partial', cause: problems.join('\n') } : { state: 'complete' } };
}
