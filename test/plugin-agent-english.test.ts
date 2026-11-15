/**
 * An agent's task is in English only (madarch-64o5.107): every locale map a task or a contract carries is resolved to
 * its English text before the prompt is built, a map with no English text is left out rather than sent in another
 * language, and the task a scripted domain run sends shrinks by the second language it no longer repeats.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcpConnection, AcpSession } from '../src/fill/acp.js';
import { PluginAgentBridge, type PluginAgentOptions } from '../src/plugin/agent.js';
import { englishOnly, isLocaleMap } from '../src/plugin/english-task.js';
import type { PluginUnitResult } from '../src/plugin/protocol.js';
import { agentMeaningOf } from '../src/product/manifest/kinds.js';

const outputs = { vertices: [{ kind: 'domain', key: ['id'], fields: [{ name: 'id', type: 'text' as const, required: true, meaning: 'The area’s stable identity.', example: 'billing' }] }], edges: [] };
const result: PluginUnitResult = { unitId: 'ignored', vertices: [], end: { state: 'complete' } };

/** A kind as the manifest declares it: the same words in two languages, as an agent used to be sent them. */
function domainKind(): Record<string, unknown> {
  const labels = { en: { one: 'Domain', many: 'Domains' }, ru: { one: 'Домен', many: 'Домены' } };
  return {
    name: 'domain',
    group: 'docs',
    descriptions: { en: 'A bounded area of the product whose rules and vocabulary stand together.', ru: 'Ограниченная область продукта, где правила и словарь стоят вместе.' },
    labels,
    fields: [
      { name: 'id', type: 'text', labels: { en: 'Identifier', ru: 'Идентификатор' } },
      { name: 'definition', type: 'text', evidence: true, labels: { en: 'Definition', ru: 'Определение' } },
      { name: 'rules', type: 'text', labels: { en: 'Rules', ru: 'Правила' } },
      { name: 'vocabulary', type: 'text', labels: { en: 'Vocabulary', ru: 'Словарь' } },
    ],
    key: ['id'],
    line: 7,
  };
}

/** The task a plugin hands its host for one agent unit: the kind twice, the contract and the graph's repositories. */
function domainTask(): Record<string, unknown> {
  const kind = domainKind();
  return { kind, kinds: [kind], contract: outputs, files: [], edgeOutputs: [], outputKinds: ['domain'], repositories: [{ name: 'app', commit: 'a1b2c3d4' }] };
}

/** A bridge whose one session answers the fixture result and hands back the prompt it was given. */
async function promptOf(task: Record<string, unknown>): Promise<string> {
  let seen = '';
  const root = mkdtempSync(join(tmpdir(), 'madarch-english-task-'));
  try {
    const bridge = new PluginAgentBridge({ prompt: 'Fill the kind from its documents.', roots: ['.'] }, {
      adapter: { id: 'fixture', command: 'fixture' },
      connect: async () => {
        const session = {
          sessionId: 'session-1', model: 'fixture-model', configOptions: [], models: null,
          usage: () => ({ reported: false, turns: 1, reports: 0 }),
          prompt: async (text: string) => { seen = text; return { stopReason: 'end_turn', text: JSON.stringify(result), updates: [] }; },
        } as unknown as AcpSession;
        return { spec: { id: 'fixture', command: 'fixture' }, executable: '/fixture', initialize: async () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }), newSession: async () => session, stderr: () => '', close: async () => undefined, closed: new Promise<void>(() => undefined) } as unknown as AcpConnection;
      },
    } as PluginAgentOptions, { files: async () => [], value: async () => null }, outputs);
    await bridge.run('agent-fill:domain', task);
    return seen;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Estimated tokens: the usual four characters to a token, for a number before and after the change. */
const tokensOf = (text: string): number => Math.round(text.length / 4);

describe('an agent’s task is English only', () => {
  test('every locale map is its English text, and a map with no English text is left out', () => {
    const task = domainTask();
    const resolved = englishOnly(task) as Record<string, unknown>;
    const kind = resolved['kind'] as Record<string, unknown>;
    expect(kind['descriptions']).toEqual({ en: 'A bounded area of the product whose rules and vocabulary stand together.' }.en);
    expect((kind['labels'] as Record<string, unknown>)['one']).toBe('Domain');
    expect((kind['labels'] as Record<string, unknown>)['many']).toBe('Domains');
    expect((kind['fields'] as { labels: unknown }[])[1]?.labels).toBe('Definition');
    // Only the keys the manifest declares localized are read as translations: an object whose keys merely look like
    // language tags is data and passes untouched (madarch-64o5.107).
    const mixed = { note: { ru: 'Только по-русски' }, id: 'billing', count: 3, list: ['a', { en: 'A', ru: 'А' }] } as unknown as Record<string, unknown>;
    expect(englishOnly(mixed)).toEqual(mixed);
    expect(englishOnly({ values: { id: 'billing', os: 'linux' } })).toEqual({ values: { id: 'billing', os: 'linux' } });
    expect(englishOnly({ schema: { type: 'object', properties: { en: { type: 'string' }, ru: { type: 'number' } }, required: ['en', 'ru'] } }))
      .toEqual({ schema: { type: 'object', properties: { en: { type: 'string' }, ru: { type: 'number' } }, required: ['en', 'ru'] } });
    // A declared key with no English text is left out; a plain string under a declared key stands.
    expect(englishOnly<Record<string, unknown>>({ labels: { ru: 'Только по-русски' }, description: 'A sentence.' })).toEqual({ description: 'A sentence.' });
    expect(isLocaleMap({ en: 'x', ru: 'y' })).toBe(true);
    expect(isLocaleMap({ one: 'x', many: 'y' })).toBe(false);
    // A key is a language when the manifest declares that language, nothing else: a tag it does not declare is data.
    expect(isLocaleMap({ en: 'x', de: 'y' })).toBe(false);
    expect(isLocaleMap({ 'en-GB': 'x', 'ru-RU': 'y' })).toBe(false);
    expect(isLocaleMap({ en: 'x', ru: 'y', de: 'z' })).toBe(false);
    expect(englishOnly<Record<string, unknown>>({ labels: { en: 'Identifier', de: 'Bezeichner' } }))
      .toEqual({ labels: { en: 'Identifier', de: 'Bezeichner' } });
    expect(isLocaleMap({ name: 'domain' })).toBe(false);
    const text = JSON.stringify(resolved);
    expect(text).not.toMatch(/[\u0400-\u04FF]/u);
    // The declared task is untouched: the resolution answers a copy.
    expect(JSON.stringify(task)).toContain('Домен');
  });

  test('the prompt an agent is sent carries no Russian, and the English words stand once', async () => {
    const prompt = await promptOf(domainTask());
    expect(prompt).not.toMatch(/[\u0400-\u04FF]/u);
    expect(prompt).toContain('A bounded area of the product whose rules and vocabulary stand together.');
    expect(prompt.match(/Domains/gu)).toHaveLength(2);
    expect(prompt).toContain('Fill the kind from its documents.');
  });

  test('a scripted domain task shrinks by its second language, measured in characters and tokens', async () => {
    const task = domainTask();
    const before = JSON.stringify(task);
    const after = JSON.stringify(englishOnly(task));
    const promptBefore = `Task: ${before}\nOutput contract: ${JSON.stringify(outputs)}`;
    const promptAfter = `Task: ${after}\nOutput contract: ${JSON.stringify(englishOnly(outputs))}`;
    expect(after.length).toBeLessThan(before.length);
    expect(after).not.toMatch(/[\u0400-\u04FF]/u);
    // The numbers this change is measured by: the task alone, and the whole prompt around it.
    console.log('ENGLISH-TASK-SIZE', JSON.stringify({
      task: { before: before.length, after: after.length, saved: before.length - after.length, tokensBefore: tokensOf(before), tokensAfter: tokensOf(after), tokensSaved: tokensOf(before) - tokensOf(after) },
      prompt: { before: promptBefore.length, after: promptAfter.length, tokensBefore: tokensOf(promptBefore), tokensAfter: tokensOf(promptAfter) },
    }));
    expect(await promptOf(task)).not.toMatch(/[\u0400-\u04FF]/u);
  });
});


test("the meaning madarch builds from a starter kind's two languages is the English description alone", () => {
  // The production path (madarch-64o5.107): a catalogue-agent kind whose description is declared in two languages, and a
  // field with no agent binding takes its meaning from that description. The join must read English only.
  const kind = { descriptions: { en: 'An area.', ru: 'Область.' }, labels: { en: 'Area', ru: 'Область' } };
  const meaning = agentMeaningOf(kind, { name: 'note', type: 'text' } as never);
  expect(meaning).toBe('An area.');
  expect(JSON.stringify(meaning)).not.toMatch(/[\u0400-\u04FF]/u);
  // A field whose agent binding states its description keeps that one text; a kind with no English description names
  // the field itself rather than another language.
  expect(agentMeaningOf({ descriptions: { ru: 'Область.' } }, { name: 'note', binding: { kind: 'agent', description: 'The note.' } } as never)).toBe('The note.');
  expect(agentMeaningOf({ descriptions: { ru: 'Область.' } }, { name: 'note' } as never)).toBe('note');
});
