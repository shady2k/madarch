/** The general agent producer: the host supplies the kind's manifest and bounded graph context. */
import { definePlugin } from 'madarch-plugin-sdk';

await definePlugin({
  name: 'agent-fill',
  version: '1.0.0',
  graph: true,
  contract: { vertices: [], edges: [] },
  extract(unit, context) {
    return context.agent(unit.inputs);
  },
});
