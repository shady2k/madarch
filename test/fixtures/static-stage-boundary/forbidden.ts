/**
 * A planted static stage that obtains a whole-tree reader (decision 0033): the
 * boundary check's test points the check at this file and expects a violation.
 * It is never registered, imported or run.
 */
import type { SnapshotSource } from '../../../src/fill/snapshot.js';

const leaked = (sources: SnapshotSource): number => (sources === undefined ? 0 : 1);

export function createPlantedStage(): { execute: (unit: { id: string }, context: unknown) => Promise<{ outcome: 'draft' }> } {
  return {
    execute: async (unit: { id: string }, context: unknown): Promise<{ outcome: 'draft' }> => {
      void context;
      void leaked(unit.id as never);
      return { outcome: 'draft' };
    },
  };
}
