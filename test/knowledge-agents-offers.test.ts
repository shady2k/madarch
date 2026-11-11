import { expect, test } from 'bun:test';
import { WRITER_AGENTS, configuredPluginAgent, readAgentSettings } from '../src/knowledge/agents.js';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the wiki offers the four agents that can take the writer\'s tools and none that cannot', () => {
  expect(WRITER_AGENTS).toEqual(['claude-code', 'codex', 'opencode', 'omp', 'prime-agent']);
  // Pi is not offered: its adapter hands no MCP server to pi (see its catalogue entry).
  expect(WRITER_AGENTS).not.toContain('pi');
});

test('pressed agent fills resolve only a saved choice, never start an adapter while reading settings', () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-agent-choice-'));
  const file = join(folder, 'writer.json');
  try {
    expect(readAgentSettings(file)).toEqual({});
    expect(configuredPluginAgent(folder, { PATH: '' })).toBeUndefined();
    writeFileSync(file, JSON.stringify({ editorialRequestsPerPage: 2 }));
    expect(configuredPluginAgent(folder, { PATH: '' })).toBeUndefined();
    writeFileSync(file, JSON.stringify({ roles: { writing: { agent: 'unknown' } } }));
    expect(() => configuredPluginAgent(folder, { PATH: '' })).toThrow('unknown agent');
    const adapter = join(folder, 'codex-acp');
    writeFileSync(adapter, '#!/bin/sh\nexit 99\n');
    chmodSync(adapter, 0o700);
    writeFileSync(file, JSON.stringify({ agent: 'codex', model: 'fixture-model' }));
    const configured = configuredPluginAgent(folder, { PATH: folder, OPENAI_API_KEY: 'fixture-key', UNRELATED_SECRET: 'person-setting' });
    expect(configured?.adapter.command).toBe(adapter);
    expect(configured?.preferences).toEqual({ model: 'fixture-model' });
    expect(configured?.environment).toEqual(expect.objectContaining({ OPENAI_API_KEY: 'fixture-key', UNRELATED_SECRET: 'person-setting' }));
    writeFileSync(file, JSON.stringify({ agent: 'codex', model: 42 }));
    expect(() => configuredPluginAgent(folder, { PATH: '' })).toThrow(`${file}:1: writing.model is not a string`);
    writeFileSync(file, '{');
    expect(() => readAgentSettings(file)).toThrow(`${file}:1: the product settings are not JSON`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});





