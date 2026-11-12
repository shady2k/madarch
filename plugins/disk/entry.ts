import { definePlugin } from 'madarch-plugin-sdk';
import contract from './contract.json';
import { extract } from './main.js';
await definePlugin({ name: 'disk', version: '1.0.0', contract: contract.outputs as never, filesystem: true, extract });
