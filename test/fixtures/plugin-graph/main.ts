/**
 * The fixture plugin that declares no filesystem right: it reads the graph through the host and tries the repository
 * snapshot anyway, which is what the host's refusal is held against (decision 0035, item 9: a plugin reads the source
 * only when it was given it, and the files producer alone is).
 */
import { definePlugin, type Unit, type UnitResult } from 'madarch-plugin-sdk';
import { readFileSync } from 'node:fs';

/** Runs one read and answers how it ended: what was read, or the refusal's code. */
function attempt(name: string, work: () => string): UnitResult {
  try {
    return { end: { state: 'partial', cause: `${name}: read ${JSON.stringify(work().slice(0, 40))}` } };
  } catch (error) {
    const held = error as NodeJS.ErrnoException;
    return { end: { state: 'partial', cause: `${name}: refused (${held.code ?? held.message})` } };
  }
}

await definePlugin({
  name: 'plugin-graph',
  version: '1.0.0',
  graph: true,
  contract: {
    vertices: [{ kind: 'probe', key: ['id'], fields: [] }],
    edges: [],
  },
  async extract(unit: Unit): Promise<UnitResult> {
    const behavior = String(unit.key['behavior'] ?? 'read-repo');
    if (behavior === 'read-repo') return attempt('read-repo', () => readFileSync('/repo/plugin.json', 'utf8'));
    if (behavior === 'read-graph') {
      const files: { kind: string; key: Record<string, string | number> }[] = [];
      void files;
      return { end: { state: 'complete' } };
    }
    return { end: { state: 'partial', cause: `unknown behaviour ${behavior}` } };
  },
});
