import { definePlugin } from 'madarch-plugin-sdk';
import contract from './contract.json';
import { extract } from './main.js';
import { partitioned } from './partition.js';
const output = partitioned(extract);
await definePlugin({ name: 'git', version: '1.0.0', contract: contract.outputs as never, filesystem: true, graph: true, ...output });
