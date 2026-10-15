import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import puppeteer from 'puppeteer';

export interface BrowserLookupOptions {
  env?: NodeJS.ProcessEnv;
  path?: string;
  /** Override Puppeteer's downloaded-browser candidate; null disables it. */
  installedBrowserPath?: string | null;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const pathBrowsers = process.platform === 'win32'
  ? ['chrome.exe', 'chromium.exe', 'chrome', 'chromium']
  : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'chrome-browser'];

/** Resolve the browser in a stable order: explicit configuration, Puppeteer's download, then PATH. */
export function resolveBrowserExecutable(options: BrowserLookupOptions = {}): string {
  const env = options.env ?? process.env;
  const configured = env.CHROME || env.PUPPETEER_EXECUTABLE_PATH;
  if (configured !== undefined && configured !== '') {
    if (!isExecutable(configured)) throw new Error(`Configured browser does not exist: ${configured}. Set CHROME to a browser executable path.`);
    return configured;
  }

  let installed = options.installedBrowserPath;
  if (installed === undefined) {
    try {
      installed = puppeteer.executablePath();
    } catch {
      installed = null;
    }
  }
  if (installed && isExecutable(installed)) return installed;

  const searchPath = options.path ?? env.PATH ?? '';
  for (const folder of searchPath.split(delimiter)) {
    if (folder === '') continue;
    for (const name of pathBrowsers) {
      const candidate = join(folder, name);
      if (isExecutable(candidate)) return candidate;
    }
  }

  throw new Error(
    'No Chromium or Chrome browser found. Set CHROME to its executable path, install dependencies with `bun install --frozen-lockfile` to install Puppeteer’s browser, or put Chromium/Chrome on PATH.',
  );
}
