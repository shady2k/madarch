/**
 * The groups of the navigation as the app reads them (decision 0031): the manifest's own groups in its order, each with
 * its words in every interface language and the group it stands under. The kind catalogue whose rows used to be built
 * here is read through `/graphql` (decision 0036, sections 2 and 4): the server's page layer names no kind.
 */
import type { KindsManifest } from '../product/manifest/kinds.js';
import type { WikiStatus } from './model.js';

/** The groups of the navigation and the catalogue, in the manifest's order, as the app reads them. */
export function groupViews(manifest: KindsManifest): WikiStatus['groups'] {
  return [...manifest.groups.values()].map((group) => ({
    group: group.name,
    labels: { ...group.labels },
    ...(group.short === undefined ? {} : { short: { ...group.short } }),
    ...(group.parent === undefined ? {} : { parent: group.parent }),
    ...(group.open === undefined ? {} : { open: group.open }),
  }));
}
