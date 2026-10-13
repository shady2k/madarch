/**
 * The product's kinds registry on the app's side (decision 0021, outcome 3
 * of the standalone charter): where a product holds a registry, the numbers
 * the app needs come from the server's own answer — the stage list and its
 * order, each kind's name and the stage it belongs to, every next-step
 * hint. The labels of kind groups are the registry's kind names, read off
 * `/api/registry` as data; the app's own catalogues hold only the shell's
 * fixed words. Where the product holds none, everything reads the plain
 * way it did: the groups are the pages' own groups, no kind shows anywhere
 * and no stage list is invented.
 */
import { useEffect, useState } from 'react';
import { getRegistry, type RegistryOffer } from './api.js';

export type { RegistryOffer, RegistryKindEntry, RegistryStageEntry } from './api.js';

/** Reads the registry once for the open wiki; the caller rerenders it on the wiki's revision. */
export function useRegistry(revision: string): RegistryOffer | null {
  const [offer, setOffer] = useState<RegistryOffer | null>(null);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    getRegistry(controller.signal)
      .then((read) => {
        if (alive) setOffer(read);
      })
      .catch(() => {
        // An older server without the route answers nothing: the app reads
        // the plain way, as a product without a registry does.
        if (alive) setOffer(null);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [revision]);
  return offer;
}

/** The stage list the app shows from the product registry, or none. */
export function stageList(offer: RegistryOffer | null): { id: string; name?: string }[] {
  if (offer !== null && offer.present && 'stages' in offer) return offer.stages;
  return [];
}

/** The stage position of one id in the active list, or one past the end. */
export function stagePosition(offer: RegistryOffer | null, id: string): number {
  const list = stageList(offer);
  const at = list.findIndex((entry) => entry.id === id);
  return at >= 0 ? at : list.length;
}

/** The kind entry the offer holds for one kind's name. */
export function kindEntry(offer: RegistryOffer | null, kind: string): import('./api.js').RegistryKindEntry | undefined {
  if (offer === null || !offer.present || !('kinds' in offer)) return undefined;
  return offer.kinds.find((entry) => entry.name === kind);
}

/** The kind's registry data: how a kind shows (its name as data) and where it stands (its stage's position, then the file's own order). */
export function kindOrder(offer: RegistryOffer | null, kind: string): { stage: number; at: number } {
  const entry = kindEntry(offer, kind);
  if (entry === undefined) return { stage: Number.MAX_SAFE_INTEGER, at: kind.length };
  let anEntryAt = 0;
  if (offer !== null && offer.present && 'kinds' in offer) {
    const kinds = offer.kinds;
    for (const held of kinds) {
      if (held.name === kind) break;
      anEntryAt += 1;
    }
  }
  if (entry.stage === '') return { stage: Number.MAX_SAFE_INTEGER, at: anEntryAt };
  return { stage: stagePosition(offer, entry.stage), at: anEntryAt };
}
