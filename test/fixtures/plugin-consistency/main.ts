/**
 * The fixture whole-graph plugin (madarch-stm0.7.1): it reads the host's consistency records and answers one finding per
 * problem. Its id carries every value that tells two findings apart — the field, the opinion, the edge discriminator and
 * the ends — so two unevidenced fields of one entity are two findings, not one key written twice.
 */
import { definePlugin, type GraphPage, type GraphPageQuery, type GraphRemovedEnd, type GraphUnevidencedOpinion, type GraphUnresolvedReference, type Unit, type UnitResult, type VertexResult } from 'madarch-plugin-sdk';

const FINDING_KIND = 'probe.finding';

interface Finding { readonly rule: string; readonly subject: string; readonly target: string; readonly cause: string; readonly severity: 'blocker' | 'critical' | 'major' | 'minor' | 'info' }

/** Every page of one read, walked by the cursor the host answers. */
async function every<T>(read: (query?: GraphPageQuery) => Promise<GraphPage<T>>): Promise<T[]> {
  const rows: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await read(after === undefined ? { limit: 200 } : { after, limit: 200 });
    rows.push(...page.rows);
    if (page.next === undefined) return rows;
    after = page.next;
  }
}

const idOf = (...parts: readonly (string | undefined)[]): string => parts.map((one) => one ?? '').join('|');

function findingOf(finding: Finding): VertexResult {
  return { kind: FINDING_KIND, key: { id: idOf(finding.rule, finding.subject, finding.target, finding.cause) }, values: { ...finding } };
}

function unresolvedFindings(references: readonly GraphUnresolvedReference[]): Finding[] {
  return references.map((reference) => reference.edge === undefined
    ? {
        rule: 'missing-reference',
        subject: `${reference.referrer?.kind ?? 'vertex'}:${reference.referrer?.label ?? '?'}`,
        target: `${reference.target.kind}:${reference.target.label}`,
        cause: `its key field "${reference.field}" names ${reference.target.kind} ${reference.target.label}, and no vertex holds that key`,
        severity: 'major',
      }
    : {
        rule: 'dangling-reference',
        subject: `${reference.edge.kind}:${reference.referrer?.label ?? '?'}`,
        target: `${reference.target.kind}:${reference.target.label}`,
        cause: `the ${reference.field} end of ${reference.edge.kind} names ${reference.target.kind} ${reference.target.label}, and no vertex holds that key`,
        severity: 'major',
      });
}

function removedEndFindings(ends: readonly GraphRemovedEnd[]): Finding[] {
  return ends.map((end) => ({
    rule: 'removed-end',
    subject: `${end.edge.kind}:${end.from.kind}:${end.from.label}->${end.to.kind}:${end.to.label}:${end.edge.discriminator ?? ''}`,
    target: end.removed.map((side) => (side === 'from' ? end.from.label : end.to.label)).join(', '),
    cause: `the ${end.removed.join(' and ')} end of ${end.edge.kind} is removed`,
    severity: 'major',
  }));
}

function unevidencedFindings(opinions: readonly GraphUnevidencedOpinion[]): Finding[] {
  return opinions.map((opinion) => ({
    rule: 'unevidenced-opinion',
    subject: `${opinion.entity.kind}:${opinion.entity.label}`,
    target: `${opinion.producer}:${opinion.field}:${opinion.opinion}`,
    cause: `the opinion on "${opinion.field}" states no evidence, and its contract requires it`,
    severity: 'minor',
  }));
}

async function extract(_unit: Unit, context: import('madarch-plugin-sdk').ExtractContext): Promise<UnitResult> {
  const [references, ends, opinions] = await Promise.all([
    every((query) => context.graph.unresolved(query)),
    every((query) => context.graph.removedEnds(query)),
    every((query) => context.graph.unevidenced(query)),
  ]);
  return { vertices: [...unresolvedFindings(references), ...removedEndFindings(ends), ...unevidencedFindings(opinions)].map(findingOf), end: { state: 'complete' } };
}

await definePlugin({
  name: 'plugin-consistency',
  version: '1.0.0',
  reads: 'whole-graph',
  graph: true,
  graphReads: ['unresolved', 'removedEnds', 'unevidenced'],
  contract: {
    vertices: [{
      kind: FINDING_KIND,
      key: ['id'],
      fields: [
        { name: 'id', type: 'text', meaning: "The finding's stable identity.", example: 'removed-end:contains:src:a.ts:to', required: true },
        { name: 'rule', type: 'text', meaning: 'The rule that found it.', example: 'removed-end', required: true },
        { name: 'subject', type: 'text', meaning: 'The entity the finding is about.', example: 'contains src → a.ts', required: true },
        { name: 'target', type: 'text', meaning: 'What the finding names beside its subject.', example: 'a.ts', required: false },
        { name: 'cause', type: 'text', meaning: 'Why the finding stands.', example: 'the to end is removed', required: true },
        { name: 'severity', type: 'text', meaning: 'How serious it is.', example: 'major', required: false },
      ],
    }, {
      kind: 'probe.opinion',
      key: ['id'],
      fields: [
        { name: 'id', type: 'text', meaning: "The opinion's identity.", example: 'one', required: true },
        { name: 'first', type: 'text', meaning: 'A field that must carry evidence.', example: 'a', required: false, evidence: true },
        { name: 'second', type: 'text', meaning: 'A second field that must carry evidence.', example: 'b', required: false, evidence: true },
      ],
    }],
    edges: [],
  },
  extract,
});
