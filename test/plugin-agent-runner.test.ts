import { expect, test } from 'bun:test';
import { startAgentRunner } from '../src/plugin/agent-runner.js';

test('runner rejects non-allowlisted environment before launching a process', async () => {
  await expect(startAgentRunner({ id: 'fake', command: process.execPath }, {}, { UNLISTED_TOKEN: 'not-a-real-secret' })).rejects.toThrow('non-allowlisted environment variable UNLISTED_TOKEN');
});

test('allowlisting a loader or home override cannot weaken confinement', async () => {
  for (const name of ['HOME', 'PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'BUN_OPTIONS']) {
    await expect(startAgentRunner({ id: 'fake', command: process.execPath }, { environment: [name] }, { [name]: 'blocked' })).rejects.toThrow(`non-allowlisted environment variable ${name}`);
  }
});
