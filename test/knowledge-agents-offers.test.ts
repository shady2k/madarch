import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeUnitAgent, offers, WRITER_AGENTS } from '../src/knowledge/agents.js';

test('the wiki offers the four agents that can take the writer\'s tools and none that cannot', () => {
  expect(WRITER_AGENTS).toEqual(['claude-code', 'codex', 'opencode', 'omp']);
  // Pi is not offered: its adapter hands no MCP server to pi (see its catalogue entry).
  expect(WRITER_AGENTS).not.toContain('pi');
});

test('OpenCode and omp are started as `acp` mode of their own program, found on the PATH', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-agents-offers-'));
  try {
    for (const program of ['opencode', 'omp']) {
      writeFileSync(join(root, program), '#!/bin/sh\nexit 0\n');
      chmodSync(join(root, program), 0o755);
    }
    const env = { HOME: join(root, 'home'), MADARCH_HOME: join(root, 'madarch'), PATH: root };
    const shown = offers(env);
    expect(shown.map((offer) => [offer.id, offer.installed])).toEqual([['claude-code', false], ['codex', false], ['opencode', true], ['omp', true]]);
    const missing = shown.find((offer) => offer.id === 'codex')!;
    expect(missing.install?.package).toBe('@agentclientprotocol/codex-acp');
    for (const id of ['opencode', 'omp']) {
      const agent = makeUnitAgent(id, env);
      expect('error' in agent).toBe(false);
      if (!('error' in agent)) await agent.close();
    }
    const absent = makeUnitAgent('claude-code', env);
    expect('error' in absent && absent.error).toContain('Claude Code adapter is not installed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
