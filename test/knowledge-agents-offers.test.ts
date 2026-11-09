import { expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeUnitAgent, offers, WRITER_AGENTS } from '../src/knowledge/agents.js';

test('the wiki offers the four agents that can take the writer\'s tools and none that cannot', () => {
  expect(WRITER_AGENTS).toEqual(['claude-code', 'codex', 'opencode', 'omp', 'prime-agent']);
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
    expect(shown.map((offer) => [offer.id, offer.installed])).toEqual([['claude-code', false], ['codex', false], ['opencode', true], ['omp', true], ['prime-agent', false]]);
    const missing = shown.find((offer) => offer.id === 'codex')!;
    expect(missing.where).toBeNull();
    expect(missing.version).toBeNull();
    expect(missing.install).toMatchObject({ kind: 'npm', package: '@agentclientprotocol/codex-acp' });
    const bundled = shown.find((offer) => offer.id === 'prime-agent')!;
    // A bundled program is never described with a package, a version or a folder madarch would install it into.
    expect(bundled.install).toEqual({ kind: 'bundled', program: 'prime-agent', note: expect.stringContaining('Install prime-agent') });
    for (const id of ['opencode', 'omp']) {
      const offer = shown.find((candidate) => candidate.id === id)!;
      expect(offer.where).toBe(join(root, id));
      expect(offer.version).toBeNull();
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


test('makeUnitAgent launches the fake binary with its session cwd and only runtime env', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-prime-agent-launch-'));
  const daemon = createServer();
  try {
    const socket = join(root, 'daemon.sock');
    await new Promise<void>((resolve) => daemon.listen(socket, resolve));
    const stat = lstatSync(socket);
    const fields = readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ').slice(1).join(') ').trim().split(/\s+/);
    const runtime = join(root, 'runtime-ready.json');
    const marker = 'MADARCH_PARENT_SECRET_MARKER';
    const childEnvFile = join(root, 'child-env.json');
    const argvFile = join(root, 'child-argv.json');
    const sessionCwdFile = join(root, 'session-cwd.json');
    const bin = join(root, 'madarch', 'agents', 'prime-agent', 'node_modules', '.bin');
    writeFileSync(runtime, JSON.stringify({ phase: 'ready', socket, socket_dev: stat.dev, socket_ino: stat.ino, processes: [], controller: { pid: process.pid, ticks: fields[19] }, env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin`, CAPTURE_ENV: childEnvFile, CAPTURE_ARGV: argvFile, CAPTURE_SESSION_CWD: sessionCwdFile } }));
    const binary = join(bin, 'prime-agent');
    const script = `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.env.CAPTURE_ENV,JSON.stringify(process.env));fs.writeFileSync(process.env.CAPTURE_ARGV,JSON.stringify(process.argv.slice(2)));let b='';process.stdin.on('data',d=>{b+=d;for(;;){let n=b.indexOf('\\n');if(n<0)break;let m=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(m.method==='session/new')fs.writeFileSync(process.env.CAPTURE_SESSION_CWD,JSON.stringify(m.params.cwd));let result=m.method==='initialize'?{protocolVersion:1,agentCapabilities:{mcpCapabilities:{http:true,sse:true}},agentInfo:{name:'fake',version:'1'},authMethods:[]}:m.method==='session/new'?{sessionId:'s'}:m.method==='session/prompt'?{stopReason:'end_turn'}:null;if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}});\n`;
    mkdirSync(bin, { recursive: true }); writeFileSync(binary, script); chmodSync(binary, 0o755);
    const env = { HOME: root, MADARCH_HOME: join(root, 'madarch'), MADARCH_PRIME_RUNTIME_READY: runtime, MADARCH_PRIME_PROVIDER: 'provider', MADARCH_PRIME_MODEL: 'model', [marker]: 'parent-only', PATH: `${bin}:/usr/bin` };
    const agent = makeUnitAgent('prime-agent', env);
    expect('error' in agent).toBe(false);
    if ('error' in agent) return;
    const status = await agent.run({ id: 'unit-1', prompt: 'test', tools: { definitions: [], call: async () => ({ answer: { content: [] }, isError: false }), finished: () => false } });
    expect(status?.completed).toBe(false);
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    const sessionCwd = argv[argv.indexOf('--cwd') + 1];
    expect(sessionCwd).toBeTruthy();
    expect(JSON.parse(readFileSync(sessionCwdFile, 'utf8'))).toBe(sessionCwd);
    expect(JSON.parse(readFileSync(childEnvFile, 'utf8'))).toEqual({ PATH: `${bin}:${dirname(process.execPath)}:/usr/bin`, CAPTURE_ENV: childEnvFile, CAPTURE_ARGV: argvFile, CAPTURE_SESSION_CWD: sessionCwdFile });
    expect(JSON.parse(readFileSync(childEnvFile, 'utf8'))[marker]).toBeUndefined();
    await agent.close();
  } finally { daemon.close(); rmSync(root, { recursive: true, force: true }); }
});
