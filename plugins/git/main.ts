import type { ExtractContext, Unit, UnitResult, VertexResult, EdgeResult } from 'madarch-plugin-sdk';
import { readRepositoryHistory, shallowGapOf, type RepositoryAt } from './reader.js';

/** What the git plugin states about one path: its change count, its last change and the latest period it existed. */
type PathFacts = {
  readonly commit_count: number;
  readonly last_change: string | null;
  readonly added_at: string | null;
  readonly added_in: string | null;
  readonly removed_at: string | null;
  readonly removed_in: string | null;
};

/** The git plugin reads disk identities, then interprets history from pinned repository objects. */
export async function extract(unit: Unit, context: ExtractContext): Promise<UnitResult> {
  const inputs = unit.inputs as { repositories: readonly RepositoryAt[]; edgeOutputs: readonly { kind: string; from: string; to: string }[]; keys?: readonly { hash: string }[]; contract: { vertices: readonly { kind: string; fields: readonly { name: string }[] }[]; edges: readonly { kind: string }[] } };
  if (!Array.isArray(inputs?.repositories)) throw new Error('git needs pinned repository inputs');
  const vertices: VertexResult[] = [], edges: EdgeResult[] = [], problems: string[] = [];
  const files = unit.kind === 'code.repository' ? [] : await context.graph.files('**/*');
  const known = new Set(files.map(file => `${String(file.key['repository'])}\0${String(file.key['path'])}`));
  const authors = new Set<string>();
  const paths = new Set<string>();
  const fileIdentity = (repository: string, path: string, commit: string, values: PathFacts): void => {
    const identity = JSON.stringify([repository, path]);
    if (paths.has(identity)) return;
    paths.add(identity);
    vertices.push({ kind: 'code.file', key: { repository, path }, values, evidence: { repository, path, commitOrDigest: commit } });
  };
  for (const pin of inputs.repositories) {
    if (context.signal.aborted) throw new Error('git extraction cancelled');
    const repository = { kind: 'code.repository', key: { name: pin.repository } };
    // This read is a real declared dependency, not a scheduling hint alone.
    await context.graph.value('code.repository', repository.key, 'url');
    const evidence = { repository: pin.repository, commitOrDigest: pin.commit };
    if (unit.kind === 'code.repository') {
      const gap = await shallowGapOf(pin);
      vertices.push({ ...repository, values: { history_shallow: gap !== null }, evidence });
      context.progress(vertices.length, undefined, pin.repository);
      continue;
    }
    const history = await readRepositoryHistory(pin, { touched: unit.kind !== 'code.author', counts: unit.kind === 'code.commit' });
    // Count exact-path changes once per commit the touched edges hold, merge commits included; a rename does not
    // transfer the old path's history.
    const changes = new Map<string, { commit_count: number; last_change: string | null }>();
    for (const held of history.commits) {
      const date = new Date(held.commitDate).toISOString();
      for (const path of new Set(held.touched.map(touched => touched.path))) {
        const facts = changes.get(path) ?? { commit_count: 0, last_change: null };
        facts.commit_count += 1;
        if (facts.last_change === null || date > facts.last_change) facts.last_change = date;
        changes.set(path, facts);
      }
    }
    // The latest period of each path's existence follows the first-parent history of the pin: each commit is diffed
    // against its first parent, merge commits included, so a deletion the merge itself made is its removal and a
    // change the merge discarded is no change at all. The history is walked oldest first, so an add begins a period and
    // clears the removal of a path added again, and a delete or a rename away ends it.
    const byHash = new Map(history.commits.map((held) => [held.hash, held]));
    const firstParent: typeof history.commits[number][] = [];
    for (let held = byHash.get(pin.commit); held !== undefined; held = held.parents[0] === undefined ? undefined : byHash.get(held.parents[0]!)) firstParent.push(held);
    // A commit git lists in .git/shallow has an absent parent, so its diff against it is no change it can read: every
    // file in its tree looks added. Only those commits are boundaries; a genuine root elsewhere keeps its additions.
    const boundaries = new Set(history.shallowBoundaries);
    type Period = { added_at: string | null; added_in: string | null; removed_at: string | null; removed_in: string | null };
    const emptyPeriod = (): Period => ({ added_at: null, added_in: null, removed_at: null, removed_in: null });
    const periodsOf = (commits: readonly (typeof history.commits)[number][]): Map<string, Period> => {
      const out = new Map<string, Period>();
      for (const held of commits) {
        const at = new Date(held.commitDate).toISOString();
        for (const touched of held.touched) {
          if (touched.change === 'added' || touched.change === 'renamed') {
            if (!boundaries.has(held.hash)) out.set(touched.path, { added_at: at, added_in: held.hash, removed_at: null, removed_in: null });
          } else if (touched.change === 'deleted') {
            out.set(touched.path, { ...(out.get(touched.path) ?? emptyPeriod()), removed_at: at, removed_in: held.hash });
          }
          if (touched.change === 'renamed' && touched.previousPath !== undefined) {
            out.set(touched.previousPath, { ...(out.get(touched.previousPath) ?? emptyPeriod()), removed_at: at, removed_in: held.hash });
          }
        }
      }
      return out;
    };
    const periods = periodsOf([...firstParent].reverse());
    // A path only a side branch ever held never stands on the first-parent walk. If the default branch's tree does not
    // hold it, its own commits state the period: the full history names the commit that added it and the one that
    // deleted it. A path absent from the tree without a deletion ends at the pin, so `current = removed_at empty`
    // holds for every path.
    const fullPeriods = periodsOf([...history.commits].reverse());
    const tree = new Set(files.filter((file) => file.key['repository'] === pin.repository).map((file) => String(file.key['path'])));
    for (const [path, period] of fullPeriods) {
      if (tree.has(path)) continue;
      const held = periods.get(path);
      if (held === undefined || held.removed_at === null) periods.set(path, period);
    }
    const pinCommit = byHash.get(pin.commit);
    for (const [path, period] of periods) {
      if (tree.has(path) || period.removed_at !== null) continue;
      periods.set(path, { ...period, removed_in: pin.commit, removed_at: pinCommit === undefined ? null : new Date(pinCommit.commitDate).toISOString() });
    }
    const factsOf = (path: string): PathFacts => ({
      ...(changes.get(path) ?? { commit_count: 0, last_change: null }),
      ...(periods.get(path) ?? emptyPeriod()),
    });
    for (const file of files) if (file.key['repository'] === pin.repository) fileIdentity(pin.repository, String(file.key['path']), pin.commit, factsOf(String(file.key['path'])));
    vertices.push({ ...repository, values: { history_shallow: history.gaps.some(gap => gap.reason === 'shallow-history') }, evidence });
    const hashes = inputs.keys === undefined ? undefined : new Set(inputs.keys.map(key => key.hash));
    for (const [walk, held] of history.commits.entries()) {
      if (unit.kind === 'code.commit' && hashes !== undefined && !hashes.has(held.hash)) continue;
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
        fileIdentity(pin.repository, touched.path, pin.commit, factsOf(touched.path));
        if (touched.previousPath !== undefined) fileIdentity(pin.repository, touched.previousPath, pin.commit, factsOf(touched.previousPath));
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

export function instantOf(text: string): [string, number] {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:(Z)|([+-])(\d{2}):(\d{2}))$/.exec(text);
  if (match === null) throw new Error(`unreadable git date ${JSON.stringify(text)}`);
  return [new Date(text).toISOString(), match[2] === 'Z' ? 0 : (match[3] === '-' ? -1 : 1) * (Number(match[4]) * 60 + Number(match[5]))];
}
