import { definePlugin } from 'madarch-plugin-sdk';
import contract from './contract.json';
import { extract } from './main.js';
import { readBlobText } from './reader.js';
import { partitioned } from './partition.js';
const output = partitioned(extract);
await definePlugin({
  name: 'git', version: '1.0.0', contract: contract.outputs as never, filesystem: true, graph: true, ...output,
  // A file's text is read by blob id from this repository's objects (decision 0037): the host asks, the plugin reads.
  read: async (request) => await readBlobText(request.repository, request.blob, { ...(request.from === undefined ? {} : { from: request.from }), ...(request.to === undefined ? {} : { to: request.to }) }),
});
