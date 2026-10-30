/**
 * The model and the reasoning level are the agent's to name (madarch-m38l.11): what `session/new` reports is what
 * madarch offers, and a saved choice is set back through `session/set_config_option` (or `session/set_model` for the
 * earlier form), nothing else. The agent is the fake one of the ACP tests, started as a real adapter is.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAcpAgent, readConfigOptions, type AcpConnection } from '../src/fill/acp.js';
import { applyPreferences, choicesOf } from '../src/fill/acp-choices.js';
import { queryAgentChoices } from '../src/knowledge/agents.js';

const FAKE_AGENT = join(import.meta.dir, 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts');
const scratch: string[] = [];
const connections: AcpConnection[] = [];
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close().catch(() => undefined);
  for (const folder of scratch.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const made = mkdtempSync(join(tmpdir(), 'madarch-choices-test-'));
  scratch.push(made);
  return made;
}

async function session(...extra: string[]): Promise<{ session: Awaited<ReturnType<AcpConnection['newSession']>>; sent: () => { method?: string; params?: Record<string, unknown> }[] }> {
  const where = folder();
  const record = join(where, 'record.jsonl');
  writeFileSync(record, '');
  const connection = await connectAcpAgent({ id: 'fake', command: process.execPath, args: [FAKE_AGENT, '--record', record, ...extra] }, { cwd: where });
  connections.push(connection);
  await connection.initialize();
  return { session: await connection.newSession({ cwd: where }), sent: () => readFileSync(record, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> }) };
}

describe('what the agent reports', () => {
  test('an agent that reports nothing offers nothing: no model and no reasoning level', async () => {
    const { session: opened } = await session();
    expect(opened.configOptions).toEqual([]);
    expect(choicesOf(opened)).toEqual({ model: null, reasoning: null });
  }, 30_000);

  test('the model and the reasoning level are told by the agent\'s own options, grouped values flattened, the mode left out', async () => {
    const { session: opened } = await session('--models');
    const choices = choicesOf(opened);
    expect(choices.model).toEqual({ configId: 'model', name: 'Model', current: 'sonnet', values: [{ value: 'sonnet', name: 'Sonnet 4.6', description: 'Balanced' }, { value: 'opus', name: 'Opus 4.7' }] });
    expect(choices.reasoning).toEqual({ configId: 'effort', name: 'Reasoning effort', current: 'medium', values: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] });
  }, 30_000);

  test('the earlier form, a list of models beside the options, is read too', async () => {
    const { session: opened } = await session('--models', 'legacy');
    expect(choicesOf(opened).model).toEqual({ configId: null, name: 'Model', current: 'sonnet', values: [{ value: 'sonnet', name: 'Sonnet 4.6', description: 'Balanced' }, { value: 'opus', name: 'Opus 4.7' }] });
    expect(choicesOf(opened).reasoning).toBeNull();
    const configured = await session('--models');
    expect(configured.session.model).toBe('sonnet');
    expect(choicesOf(configured.session).model?.current).toBe('sonnet');
  }, 30_000);

  test('options that are not a select, or are unreadable, are left out', () => {
    expect(readConfigOptions([{ id: 'flag', name: 'Flag', type: 'boolean', currentValue: true }, { id: 'x' }, null, 'text', { id: 'model', name: 'Model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }, { nope: 1 }] }])).toEqual([{ id: 'model', name: 'Model', category: null, current: 'a', values: [{ value: 'a', name: 'A' }] }]);
    expect(readConfigOptions(undefined)).toEqual([]);
  });
});

describe('setting the reader\'s choice', () => {
  test('exactly the values chosen are set through the agent\'s own option ids, and a value already in force is not sent again', async () => {
    const { session: opened, sent } = await session('--models');
    await applyPreferences(opened, { model: 'sonnet', reasoning: 'medium' });
    expect(sent().filter((message) => message.method === 'session/set_config_option')).toEqual([]);
    await applyPreferences(opened, { reasoning: 'high' });
    expect(sent().filter((message) => message.method === 'session/set_config_option').map((call) => call.params)).toEqual([{ sessionId: opened.sessionId, configId: 'effort', value: 'high' }]);
  }, 30_000);

  test('choosing a model that resets the reasoning level does not skip the saved level: the state the agent answered is what is compared', async () => {
    const { session: opened, sent } = await session('--models');
    await applyPreferences(opened, { model: 'opus', reasoning: 'medium' });
    expect(sent().filter((message) => message.method === 'session/set_config_option').map((call) => [call.params?.['configId'], call.params?.['value']])).toEqual([['model', 'opus'], ['effort', 'medium']]);
    expect(choicesOf(opened).reasoning?.current).toBe('medium');
  }, 30_000);

  test('a value the agent no longer offers is skipped and told, never sent', async () => {
    const { session: opened, sent } = await session('--models');
    const told: string[] = [];
    const said = await applyPreferences(opened, { model: 'retired-model', reasoning: 'high' }, (line) => told.push(line));
    expect(sent().filter((message) => message.method === 'session/set_config_option').map((call) => call.params?.['value'])).toEqual(['high']);
    expect(told).toEqual(['the agent no longer offers "retired-model" as the model, so the agent\'s own was kept']);
    // The same lines are handed back, so a judge or a fill can report them where the reader looks (madarch-j6ho.2).
    expect(said).toEqual(told);
  }, 30_000);

  test('an agent with no such choice is told, and the earlier form is set by `session/set_model`', async () => {
    const plain = await session();
    const told: string[] = [];
    await applyPreferences(plain.session, { model: 'opus' }, (line) => told.push(line));
    expect(told).toEqual(['the agent reports no model to choose, so "opus" was not set']);
    expect(plain.sent().some((message) => message.method === 'session/set_config_option' || message.method === 'session/set_model')).toBe(false);
    const legacy = await session('--models', 'legacy');
    await applyPreferences(legacy.session, { model: 'opus' });
    expect(legacy.sent().filter((message) => message.method === 'session/set_model').map((call) => call.params)).toEqual([{ sessionId: legacy.session.sessionId, modelId: 'opus' }]);
  }, 30_000);
});

describe('asking an installed adapter', () => {
  function adapter(extra: string): { env: Record<string, string>; record: string } {
    const where = folder();
    const bin = join(where, 'bin');
    mkdirSync(bin);
    const record = join(where, 'record.jsonl');
    writeFileSync(record, '');
    writeFileSync(join(bin, 'claude-agent-acp'), `#!/bin/sh\nexec ${process.execPath} ${FAKE_AGENT} --record ${record} ${extra}\n`);
    chmodSync(join(bin, 'claude-agent-acp'), 0o755);
    return { env: { HOME: join(where, 'user'), PATH: `${bin}:${process.env.PATH ?? ''}` }, record };
  }

  test('starts it, opens one session with no tools, reads the options and stops: no prompt is sent', async () => {
    const { env, record } = adapter('--models');
    const answer = await queryAgentChoices('claude-code', env);
    expect(answer.ok).toBe(true);
    if (answer.ok) {
      expect(answer.choices.model?.values.map((value) => value.value)).toEqual(['sonnet', 'opus']);
      expect(answer.choices.reasoning?.values.map((value) => value.value)).toEqual(['low', 'medium', 'high']);
    }
    const methods = readFileSync(record, 'utf8').split('\n').filter((line) => line !== '').map((line) => (JSON.parse(line) as { method?: string }).method);
    expect(methods).toEqual(['initialize', 'session/new']);
  }, 30_000);

  test('an adapter that is not there is told by name and where it was looked for; an agent madarch does not offer is refused', async () => {
    const missing = await queryAgentChoices('claude-code', { HOME: join(folder(), 'user'), PATH: join(folder(), 'empty') });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain('adapter is not installed');
    const unknown = await queryAgentChoices('not-an-agent', {});
    expect(unknown.ok).toBe(false);
  }, 30_000);

  test('an adapter that fails to open a session is an answer in words', async () => {
    const { env } = adapter('--scenario auth-required');
    const answer = await queryAgentChoices('claude-code', env);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.message).toContain('could not tell its models');
  }, 30_000);
});
