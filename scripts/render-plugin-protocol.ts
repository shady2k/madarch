import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PluginProtocolMessage } from '../src/plugin/protocol.js';

writeFileSync(fileURLToPath(new URL('../schema/plugin-protocol.schema.json', import.meta.url)), `${JSON.stringify(PluginProtocolMessage, null, 2)}\n`);
