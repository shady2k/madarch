import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPreparedServer } from './prepared-server.js';
import { withStorePreparationOwner } from '../src/product/store-preparation.js';

test('fixture acquisitions restore their live owner descriptor and retain it until the last server closes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-owner-lifetime-'));
  const home = join(root, 'products');
  const appFolder = join(root, 'app');
  mkdirSync(home); mkdirSync(appFolder);
  writeFileSync(join(appFolder, 'index.html'), '<title>fixture</title>');
  const first = await startPreparedServer({ productHome: home, appFolder, port: 0, log: () => undefined });
  let second: Awaited<ReturnType<typeof startPreparedServer>> | undefined;
  try {
    const url = process.env['MADARCH_STORE_OWNER_URL'];
    const token = process.env['MADARCH_STORE_OWNER_TOKEN'];
    expect(typeof url).toBe('string');
    delete process.env['MADARCH_STORE_OWNER_URL'];
    delete process.env['MADARCH_STORE_OWNER_TOKEN'];
    second = await startPreparedServer({ productHome: home, appFolder, port: 0, log: () => undefined });
    expect(process.env['MADARCH_STORE_OWNER_URL']).toBe(url);
    expect(process.env['MADARCH_STORE_OWNER_TOKEN']).toBe(token);
    await first.stop();
    expect((await fetch(url!)).status).toBe(403);
    expect(process.env['MADARCH_STORE_OWNER_URL']).toBe(url);
  } finally {
    await second?.stop();
    await first.stop();
    rmSync(root, { recursive: true, force: true });
  }
  expect(process.env['MADARCH_STORE_OWNER_URL']).toBeUndefined();
}, 30_000);

test('an old owner scope never deletes a replacement owner descriptor', async () => {
  try {
    await withStorePreparationOwner(async () => {
      process.env['MADARCH_STORE_OWNER_URL'] = 'http://127.0.0.1:1';
      process.env['MADARCH_STORE_OWNER_TOKEN'] = 'replacement-owner';
    });
    expect(process.env['MADARCH_STORE_OWNER_URL']).toBe('http://127.0.0.1:1');
    expect(process.env['MADARCH_STORE_OWNER_TOKEN']).toBe('replacement-owner');
  } finally {
    delete process.env['MADARCH_STORE_OWNER_URL'];
    delete process.env['MADARCH_STORE_OWNER_TOKEN'];
  }
}, 30_000);
