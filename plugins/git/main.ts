import type { ExtractContext, Unit, UnitResult, VertexResult, EdgeResult } from 'madarch-plugin-sdk';
import { readRepositoryHistory, type RepositoryAt } from './reader.js';

/** The git plugin reads disk identities, then interprets history from pinned repository objects. */
export async function extract(unit: Unit, context: ExtractContext): Promise<UnitResult> {
  const inputs = unit.inputs as { repositories: readonly RepositoryAt[]; edgeOutputs: readonly { kind: string; from: string; to: string }[]; contract: { vertices: readonly { kind: string; fields: readonly { name: string }[] }[]; edges: readonly { kind: string }[] } };
  if (!Array.isArray(inputs?.repositories)) throw new Error('git needs pinned repository inputs');
  const vertices: VertexResult[] = [], edges: EdgeResult[] = [], problems: string[] = [];
  const files = await context.graph.files('**/*');
  const known = new Set(files.map(file => `${String(file.key['repository'])}\0${String(file.key['path'])}`));
  const authors = new Set<string>();
  for (const pin of inputs.repositories) {
    if (context.signal.aborted) throw new Error('git extraction cancelled');
    const repository = { kind: 'code.repository', key: { name: pin.repository } };
    // This read is a real declared dependency, not a scheduling hint alone.
    await context.graph.value('code.repository', repository.key, 'url');
    const history = await readRepositoryHistory(pin);
    const evidence = { repository: pin.repository, commitOrDigest: pin.commit };
    vertices.push({ ...repository, values: { history_shallow: history.gaps.some(gap => gap.reason === 'shallow-history') }, evidence });
    for (const [walk, held] of history.commits.entries()) {
      const commit = { kind: 'code.commit', key: { hash: held.hash } };
      const author = { kind: 'code.author', key: { name: held.authorName, email: held.authorEmail } };
      const [author_date, author_offset_min] = instantOf(held.authorDate);
      const [commit_date, commit_offset_min] = instantOf(held.commitDate);
      vertices.push({ ...commit, values: { algorithm: held.hash.length === 64 ? 'sha256' : 'sha1', subject: held.subject, author_date, author_offset_min, commit_date, commit_offset_min }, evidence });
      const identity = JSON.stringify(author.key);
      if (!authors.has(identity)) { vertices.push({ ...author, evidence }); authors.add(identity); }
      edges.push({ kind: 'code.authored', from: author, to: commit, evidence }, { kind: 'code.history', from: repository, to: commit, values: { walk }, evidence });
      if (held.hash === pin.commit) edges.push({ kind: 'code.as-is', from: repository, to: commit, evidence });
      held.parents.forEach((hash, position) => edges.push({ kind: 'code.parent', from: commit, to: { kind: 'code.commit', key: { hash } }, values: { position }, evidence }));
      for (const touched of held.touched) {
        const file = { kind: 'code.file', key: { repository: pin.repository, path: touched.path } };
        // Historical paths absent from disk remain unresolved references, not invented current files.
        edges.push({ kind: 'code.touched', from: commit, to: file, values: { change: touched.change, added: touched.added, removed: touched.removed }, evidence: { ...evidence, commitOrDigest: held.hash, path: touched.path } });
        if (touched.previousPath !== undefined) edges.push({ kind: 'code.renamed-from', from: file, to: { kind: 'code.file', key: { repository: pin.repository, path: touched.previousPath } }, discriminator: held.hash, evidence });
      }
    }
    for (const gap of history.gaps) problems.push(`${pin.repository}: ${gap.what}: ${gap.reason}`);
    context.progress(history.commits.length, undefined, `${pin.repository}: ${known.size} disk files`);
  }
  const output = inputs.contract.vertices.find(vertex => vertex.kind === unit.kind);
  if (output === undefined) throw new Error(`no selected output contract for ${unit.kind}`);
  const fields = new Set(output.fields.map(field => field.name));
  const selectedVertices = vertices.filter(vertex => vertex.kind === unit.kind).map(vertex => ({ ...vertex, ...(vertex.values === undefined ? {} : { values: Object.fromEntries(Object.entries(vertex.values).filter(([field]) => fields.has(field))) }) }));
  const edgeOutputs = new Set(inputs.edgeOutputs.map(edge => JSON.stringify([edge.kind, edge.from, edge.to])));
  const selectedEdges = edges.filter(edge => edgeOutputs.has(JSON.stringify([edge.kind, edge.from.kind, edge.to.kind])));
  return { vertices: selectedVertices, edges: selectedEdges, end: problems.some(problem => !problem.endsWith('shallow-history')) ? { state: 'partial', cause: problems.join('\n') } : { state: 'complete' } };
}

function instantOf(text: string): [string, number] {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:(Z)|([+-])(\d{2}):(\d{2}))$/.exec(text);
  if (match === null) throw new Error(`unreadable git date ${JSON.stringify(text)}`);
  return [new Date(text).toISOString(), match[2] === 'Z' ? 0 : (match[3] === '-' ? -1 : 1) * (Number(match[4]) * 60 + Number(match[5]))];
}
