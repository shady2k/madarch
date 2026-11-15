/**
 * The tab's one change stream (madarch-64o5.85): a stream the server answered with 503 must be replaced when the server
 * returns, and a revision that moved while the stream was away must not be discarded as the opening revision.
 */
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useChangeStream } = await import('./command.js');
const { reportOffline, reportOnline } = await import('../connection.js');

afterAll(() => { GlobalRegistrator.unregister(); });

class FakeSource {
  static all: FakeSource[] = [];
  readyState = 0;
  closed = false;
  private readonly change: ((event: MessageEvent<string>) => void)[] = [];
  private readonly open: (() => void)[] = [];
  constructor() { FakeSource.all.push(this); }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    if (type === 'change') this.change.push(listener);
    if (type === 'open') this.open.push(listener as () => void);
  }
  close(): void { this.closed = true; this.readyState = 2; }
  emitOpen(): void { for (const listener of this.open) listener(); }
  emit(data: string): void { for (const listener of this.change) listener({ data } as MessageEvent<string>); }
}

beforeEach(() => {
  FakeSource.all = [];
  (globalThis as { EventSource?: unknown }).EventSource = FakeSource as unknown as typeof EventSource;
});

function Reader({ onNotice = () => undefined }: { readonly onNotice?: (notice: unknown) => void }): null {
  useChangeStream('', onNotice);
  return null;
}

test('a stream the server refused is replaced when the server returns', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(Reader)); });
  try {
    expect(FakeSource.all).toHaveLength(1);
    FakeSource.all[0]!.readyState = 2;
    await act(async () => {
      reportOffline();
      reportOnline();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(FakeSource.all).toHaveLength(2);
    expect(FakeSource.all[0]!.closed).toBe(true);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
});

test('a revision that moved while the stream was away is a change', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const seen: unknown[] = [];
  await act(async () => { root.render(createElement(Reader, { onNotice: (notice) => { seen.push(notice); } })); });
  try {
    const source = FakeSource.all[0]!;
    // The connection's opening revision is not a change; the next one is.
    source.emit(JSON.stringify({ revision: '1' }));
    source.emit(JSON.stringify({ revision: '2' }));
    expect(seen).toHaveLength(1);
    // The stream reconnects; its opening revision is 3 because a publication happened while it was away.
    source.emitOpen();
    source.emit(JSON.stringify({ revision: '3' }));
    expect(seen).toHaveLength(2);
    expect((seen[1] as { revision?: string }).revision).toBe('3');
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
});
