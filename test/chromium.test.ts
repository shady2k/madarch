import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBrowserExecutable } from '../scripts/chromium.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function fakeBrowser(): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-browser-test-'));
  folders.push(folder);
  const executable = join(folder, 'browser');
  writeFileSync(executable, 'fixture');
  chmodSync(executable, 0o755);
  return executable;
}

describe('resolveBrowserExecutable', () => {
  test('uses CHROME before a downloaded browser or PATH', () => {
    const configured = fakeBrowser();
    const installed = fakeBrowser();
    expect(resolveBrowserExecutable({
      env: { CHROME: configured, PATH: '' },
      installedBrowserPath: installed,
    })).toBe(configured);
  });

  test('uses PUPPETEER_EXECUTABLE_PATH when CHROME is empty', () => {
    const configured = fakeBrowser();
    expect(resolveBrowserExecutable({
      env: { CHROME: '', PUPPETEER_EXECUTABLE_PATH: configured, PATH: '' },
      installedBrowserPath: null,
    })).toBe(configured);
  });

  test('uses Puppeteer’s downloaded browser before PATH', () => {
    const installed = fakeBrowser();
    const folder = mkdtempSync(join(tmpdir(), 'madarch-browser-path-'));
    folders.push(folder);
    const pathBrowser = join(folder, 'chromium');
    writeFileSync(pathBrowser, 'fixture');
    chmodSync(pathBrowser, 0o755);
    expect(resolveBrowserExecutable({
      env: { PATH: folder },
      installedBrowserPath: installed,
    })).toBe(installed);
  });

  test('finds Chromium on PATH when no downloaded browser is present', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-browser-path-'));
    folders.push(folder);
    const executable = join(folder, 'chromium');
    writeFileSync(executable, 'fixture');
    chmodSync(executable, 0o755);
    expect(resolveBrowserExecutable({
      env: { PATH: folder },
      installedBrowserPath: null,
    })).toBe(executable);
  });

  test('reports how to provide a browser when none is available', () => {
    expect(() => resolveBrowserExecutable({ env: { PATH: '' }, installedBrowserPath: null }))
      .toThrow('Set CHROME to its executable path');
  });

  test('rejects a configured path that does not exist', () => {
    expect(() => resolveBrowserExecutable({ env: { CHROME: '/missing/chrome', PATH: '' } }))
      .toThrow('Configured browser does not exist: /missing/chrome');
  });
});
