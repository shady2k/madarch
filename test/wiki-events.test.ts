import { expect, test } from 'bun:test';
import { createWikiPart } from '../src/server/wiki-app.js';
import type { Handled, Refusal } from '../src/server/http.js';

test('the wiki stream follows graph revisions and unsubscribes when cancelled', async () => {
  let revision = '1';
  const listeners = new Set<() => void>();
  const json = (status: number, value: unknown): Response => Response.json(value, { status });
  const refused = (status: number, value: Refusal): Handled => ({ response: Response.json(value, { status }) });
  const wiki = createWikiPart(json, refused, {
    revision: () => revision,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  }, undefined);
  const controller = new AbortController();
  const stream = wiki.events(new Request('http://localhost/api/events', { signal: controller.signal })).response.body!.getReader();
  const decoder = new TextDecoder();
  expect(decoder.decode((await stream.read()).value)).toBe('retry: 3000\n\n');
  expect(decoder.decode((await stream.read()).value)).toBe('event: change\ndata: {"revision":"1"}\n\n');
  for (const listener of listeners) listener();
  revision = '2';
  for (const listener of listeners) listener();
  expect(decoder.decode((await stream.read()).value)).toBe('event: change\ndata: {"revision":"2"}\n\n');
  expect(listeners.size).toBe(1);
  await stream.cancel();
  expect(listeners.size).toBe(0);
});

test('aborting a wiki request ends its graph subscription', async () => {
  let off = false;
  const json = (status: number, value: unknown): Response => Response.json(value, { status });
  const refused = (status: number, value: Refusal): Handled => ({ response: json(status, value) });
  const wiki = createWikiPart(json, refused, {
    revision: () => '3',
    subscribe: () => () => { off = true; },
  }, undefined);
  const controller = new AbortController();
  const reader = wiki.events(new Request('http://localhost/api/events', { signal: controller.signal })).response.body!.getReader();
  await reader.read();
  await reader.read();
  controller.abort();
  expect(off).toBe(true);
  expect((await reader.read()).done).toBe(true);
});
