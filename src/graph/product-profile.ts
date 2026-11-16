/** First-filled product profile from catalogue marker rules (0039 item 35). */
import type { KindsManifest } from '../product/manifest/kinds.js';
import { matchesAny } from '../product/manifest/kinds.js';
import type { SnapshotSource } from '../plugin/repository-snapshot.js';
import type { GraphContract, VertexDraft } from './contract.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { withSpan } from '../obs/trace.js';
import { sha256Hex } from './digest.js';
import { startupBinding } from './manifest-publication.js';
import { publishGraphDrafts } from './write.js';
import { assertApplicability, cascadeApplicability, readApplicability, type KindApplicability } from './applicability.js';
import { installDisputeSelection, refreshDisputeSelection } from './disputes.js';
import { byCodePoint } from '../model/order.js';

export async function fillProductProfile(owner: DatabaseOwner, contract: GraphContract, manifest: KindsManifest, snapshots: SnapshotSource): Promise<KindApplicability[]> {
  return await withSpan('fill.product-profile',{},async () => {
    if (![...manifest.kinds.values()].some(kind => kind.applicability !== undefined || kind.profileMarkers !== undefined || kind.profileTechnologies !== undefined)) return [];
    const pins = await snapshots.pins();
    if (pins.length === 0) return await owner.run(tx => readApplicability(tx,contract));
    const paths: string[] = [];
    const trees: {repository:string;commit:string;tree:string;paths:string[]}[] = [];
    for (const pin of pins) {
      const reader = await snapshots.open(pin.id);
      if (reader.unfiled().length > 0) throw new Error(`${import.meta.path}:23: ${reader.root}: profile cannot establish absence with unfiled paths`);
      const files = reader.files().map(entry => entry.path).sort(byCodePoint);
      paths.push(...files); trees.push({repository:reader.repository,commit:reader.commit,tree:reader.tree,paths:files});
    }
    return await owner.transaction('write',async tx => {
      const {binding} = await startupBinding(tx,contract,'profile-markers');
      await installDisputeSelection(tx,contract);
      const content = JSON.stringify(trees);
      const digest = sha256Hex(new TextEncoder().encode(content));
      const producer = binding.sourceUid, producerVersion = binding.contractVersion;
      await publishGraphDrafts(tx,contract,{vertices:[{kind:'system.content-snapshot',key:{digest},values:{content},producer,producerVersion}],edges:[],removals:[]});
      const evidence = [{target:{kind:'system.content-snapshot',key:{digest}}}];
      const values: Record<string,string[]> = {};
      for (const kind of manifest.kinds.values()) {
        for (const [field,patterns] of Object.entries(kind.profileMarkers ?? {})) values[field] = paths.filter(path => matchesAny(patterns,path)).sort(byCodePoint);
        for (const [field, map] of Object.entries(kind.profileTechnologies ?? {})) {
          const technologies = new Set<string>();
          for (const path of paths) {
            const filename = path.slice(path.lastIndexOf('/') + 1);
            for (const [extension, technology] of Object.entries(map.extensions)) if (filename.endsWith(extension)) technologies.add(technology);
            for (const [name, technology] of Object.entries(map.filenames)) if (filename === name) technologies.add(technology);
          }
          values[field] = [...technologies].sort(byCodePoint);
        }
        const policy = kind.applicability;
        if (policy === undefined || policy.markers.length === 0 || pins.length === 0) continue;
        const found = paths.filter(path => matchesAny(policy.markers,path)).sort(byCodePoint);
        const reason = `Searched all ${paths.length} pinned files for ${policy.markers.join(', ')}; ${found.length === 0 ? 'no marker found' : found.join(', ')}`;
        await assertApplicability(tx,contract,kind.name,found.length === 0 ? 'inapplicable':'applicable',reason,evidence);
        if (policy.profile !== undefined) values[policy.profile] = [...new Set([...(values[policy.profile] ?? []),...found])].sort(byCodePoint);
      }
      for (const profile of manifest.kinds.values()) {
        if (profile.profileMarkers === undefined && profile.profileTechnologies === undefined) continue;
        const edge = profile.keyEdges?.find(edge => contract.edge.find(link => link.name === edge.edge)?.to.includes('system.product') === true);
        if (edge === undefined) throw new Error(`${manifest.file}:${profile.line}: profile requires a product key edge`);
        const draft: VertexDraft = {kind:profile.name,key:{},keyEdges:{[edge.role]:{kind:'system.product',uid:binding.productUid,key:{}}},values:Object.fromEntries((profile.fields ?? []).map(field => [field.name,values[field.name] ?? []])),producer,producerVersion,evidence};
        await publishGraphDrafts(tx,contract,{vertices:[draft],edges:[],removals:[]});
      }
      await cascadeApplicability(tx,contract,manifest);
      await refreshDisputeSelection(tx,contract);
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      return await readApplicability(tx,contract);
    });
  });
}
