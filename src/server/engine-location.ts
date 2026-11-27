import { join } from 'node:path';
import { releaseRoot } from '../product-wiki/release-assets.js';

const engineLocationRoots = [
  join(releaseRoot(), 'src').replaceAll('\\', '/') + '/',
  join(releaseRoot(), 'scripts').replaceAll('\\', '/') + '/',
  '/$bunfs/',
  'B:/~BUN/',
];

/** Strip the leading engine location from a client message while preserving product locations. */
export function stripEngineLocation(message: string): string {
  const separator = message.indexOf(': ');
  if (separator < 0) return message;
  const location = message.slice(0, separator).replaceAll('\\', '/');
  return engineLocationRoots.some((root) => location.startsWith(root)) ? message.slice(separator + 2) : message;
}
