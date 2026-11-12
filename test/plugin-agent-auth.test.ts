import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pluginAgentOptions } from '../src/knowledge/agents.js';

test.each([{ id: 'codex', binary: 'codex-acp', login: '.codex/auth.json' }, { id: 'claude-code', binary: 'claude-agent-acp', login: '.claude/.credentials.json' }])('a $id plugin agent retains the person HOME subscription and environment without an API key', async ({ id, binary, login }) => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-agent-auth-'));
  const home = join(root, 'person-home');
  mkdirSync(dirname(join(home, login)), { recursive: true });
  writeFileSync(join(home, login), JSON.stringify({ subscription: 'fixture-subscription' }));
  const command = join(root, binary);
  writeFileSync(command, `#!${process.execPath}
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method !== 'initialize') return;
  const auth = JSON.parse(readFileSync(join(process.env.HOME, ${JSON.stringify(login)}), 'utf8'));
  const valid = auth.subscription === 'fixture-subscription' && process.env.SUBSCRIPTION_REGION === 'fixture-region' && !process.env.OPENAI_API_KEY;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: valid ? 'subscription-ready' : 'subscription-missing' } } }) + '\\n');
});
`);
  chmodSync(command, 0o700);
  const options = pluginAgentOptions(id, { PATH: root, HOME: home, SUBSCRIPTION_REGION: 'fixture-region' }, join(root, 'runs'));
  let connection: Awaited<ReturnType<typeof options.connect>> | undefined;
  try {
    connection = await options.connect(options.adapter, { cwd: root, env: options.environment, timeoutMs: 2000, sessionTimeoutMs: 2000 });
    const initialized = await connection.initialize();
    expect(initialized.agentInfo?.name).toBe('subscription-ready');
  } finally {
    await connection?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
