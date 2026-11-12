/** Starts the protocol when Bun runs this module directly or madarch imports it from its compiled host. */
import { definePlugin } from 'madarch-plugin-sdk';
import { extract } from './main.js';
import declaration from './contract.json';

await definePlugin({
  name: 'test-quarantine', version: '1.0.0', graph: true,
  contract: declaration.outputs as Parameters<typeof definePlugin>[0]['contract'],
  extract,
});
