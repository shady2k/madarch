/**
 * The fixture plugin that declares no filesystem right: it reads the graph through the host and tries the repository
 * snapshot anyway, which is what the host's refusal is held against (decision 0035, item 9: a plugin reads the source
 * only when it was given it, and the files producer alone is).
 */
import { definePlugin, type ExtractContext, type Unit, type UnitResult } from 'madarch-plugin-sdk';
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
  graphReads: ['files', 'value', 'unresolved', 'removedEnds', 'unevidenced'],
  contract: {
    vertices: [{ kind: 'probe', key: ['id'], fields: [] }],
    edges: [],
  },
  async extract(unit: Unit, context: ExtractContext): Promise<UnitResult> {
    const behavior = String(unit.key['behavior'] ?? 'read-repo');
    if (behavior === 'read-repo') return attempt('read-repo', () => readFileSync('/repo/plugin.json', 'utf8'));
    if (behavior === 'read-graph') {
      // The one request the host's debug journal is held against: a read the plugin declared, answered or refused.
      try {
        const files = await context.graph.files('**/*.md');
        return { end: { state: 'partial', cause: `read-graph: ${String(files.length)} files` } };
      } catch (error) {
        return { end: { state: 'partial', cause: `read-graph: refused (${(error as Error).message.slice(0, 80)})` } };
      }
    }
    if (behavior === 'read-consistency') {
      try {
        const [references, ends, opinions] = await Promise.all([context.graph.unresolved(), context.graph.removedEnds(), context.graph.unevidenced()]);
        return { end: { state: 'partial', cause: `read-consistency: ${String(references.rows.length)} refs, ${String(ends.rows.length)} ends, ${String(opinions.rows.length)} opinions` } };
      } catch (error) {
        return { end: { state: 'partial', cause: `read-consistency: refused (${(error as Error).message.slice(0, 80)})` } };
      }
    }
    return { end: { state: 'partial', cause: `unknown behaviour ${behavior}` } };
  },
});
