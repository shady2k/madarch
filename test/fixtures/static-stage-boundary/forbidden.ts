/**
 * A planted static stage that reaches a whole-tree reader and a repository-wide
 * object (decision 0033, item 5): the boundary check's test points the check at
 * this file and expects one violation for each. It is never registered,
 * imported or run.
 */
import type { SnapshotSource } from '../../../src/plugin/repository-snapshot.js';

const leaked = (sources: SnapshotSource): number => (sources === undefined ? 0 : 1);

export function createPlantedStage(): { execute: (unit: { id: string }, context: { repositoryTree(): Promise<unknown> }) => Promise<{ outcome: 'draft' }> } {
  return {
    execute: async (unit: { id: string }, context: { repositoryTree(): Promise<unknown> }): Promise<{ outcome: 'draft' }> => {
      await context.repositoryTree();
      void leaked(unit.id as never);
      return { outcome: 'draft' };
    },
  };
}
