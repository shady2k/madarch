/**
 * Builds the product's stage view from its manifest and files. Stage order,
 * names, kinds and expected records come from the product registry. External
 * completeness findings are read from the committed product snapshot; this
 * module does not infer missing records from current content.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join as joinPath } from 'node:path';
import { REGISTRY_FILE } from '../product/registry.js';
import { readRegistryServing } from '../product-wiki/registry.js';
import { readProductCompleteness } from '../product/completeness.js';








/** The tracker export read when a stage declares task records. */
const TRACKER_EXPORT = '.beads/issues.jsonl';
















/**
 * The digest of stage inputs beyond the wiki pages. Snapshot bytes, tracker
 * data, and the manifest affect the live revision; unreadable inputs hash as
 * unreadable so a place coming back is a change.
 */
export function stagesSourceDigest(productFolder: string): string {
  const hash = createHash('sha256');
  const file = (path: string): void => {
    hash.update(`${path}\u0000`);
    try {
      hash.update(readFileSync(path));
    } catch {
      hash.update('unreadable\u0000');
    }
    hash.update('\u0000');
  };
  file(joinPath(productFolder, TRACKER_EXPORT));
  file(joinPath(productFolder, 'workspace.yaml'));
  // The kinds registry is a stage input and a page input alike: a saved
  // registry is a wiki change the stream reports. Its bytes reach this
  // digest only through the serving gate (readRegistryServing), never a
  // direct read: the gate names a non-regular file instead of opening it,
  // and opening a FIFO or a device here would block the ask for good.
  const registryServing = readRegistryServing(productFolder);
  if (registryServing.contract.state !== 'absent') {
    hash.update(`${REGISTRY_FILE}\u0000${registryServing.digest}\u0000`);
  }
  const completeness = readProductCompleteness(productFolder);
  if (completeness.present) hash.update(JSON.stringify(completeness));
  return hash.digest('hex');
}
