import { expect, test } from 'bun:test';
import { WRITER_AGENTS } from '../src/knowledge/agents.js';

test('the wiki offers the four agents that can take the writer\'s tools and none that cannot', () => {
  expect(WRITER_AGENTS).toEqual(['claude-code', 'codex', 'opencode', 'omp', 'prime-agent']);
  // Pi is not offered: its adapter hands no MCP server to pi (see its catalogue entry).
  expect(WRITER_AGENTS).not.toContain('pi');
});





