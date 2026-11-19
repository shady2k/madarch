import { withSpan } from '../obs/trace.js';
import type { GraphContract } from './contract.js';
import { withManifestContract } from './manifest-contract.js';
import { withAssertionContract } from './system-contract.js';
import { graphContractOf } from '../fill/stages/plugin-contract.js';
import { cataloguePageTemplate } from '../knowledge/page-template-kind.js';
import { pageTemplateKind, type KindsManifest } from '../product/manifest/kinds.js';
import type { SqlExecutor } from '../sql-driver.js';
import type { AssertionRecordSelector } from './records.js';

/** The full publication contract, including the catalogue's template kind when the product names none. */
export function publicationContractOf(manifest: KindsManifest, authored: GraphContract = graphContractOf(manifest)): GraphContract {
  const fallback = cataloguePageTemplate();
  const declared = pageTemplateKind(manifest) !== undefined || authored.vertex.some(vertex => vertex.name === fallback.name)
    ? authored : { ...authored, vertex: [...authored.vertex, fallback.vertex] };
  return withAssertionContract(withManifestContract(declared));
}

/** Read after this phase's writes, without losing PostgreSQL's sub-millisecond precision. */
export async function publicationReadSelector(tx: SqlExecutor, contract: GraphContract): Promise<AssertionRecordSelector> {
  return await withSpan('graph.publicationReadSelector', {}, async () => {
    const cutoff = (await tx.query<{ now: string }>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
    return { contract, validAt: cutoff, recordedAt: cutoff };
  });
}
