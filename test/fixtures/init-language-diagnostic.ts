import { spawnSync } from 'node:child_process';
import { reportInitFailure } from '../init-language-diagnostic.js';
import { strict as assert } from 'node:assert';
const run = spawnSync(process.execPath, ['-e', 'console.log("STDOUT-SENTINEL"); console.error("STDERR-SENTINEL"); process.exit(7)'], { encoding: 'utf8', env: { ...process.env } });
reportInitFailure(run); assert.equal(run.status, 0, 'original status assertion');
