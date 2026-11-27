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
  const firstSeparator = message.indexOf(': ');
  if (firstSeparator < 0) return message;
  // Startup publication can pass String(error), with the error name before its message.
  const start = message.slice(0, firstSeparator).endsWith('Error') ? firstSeparator + 2 : 0;
  const separator = start === 0 ? firstSeparator : message.indexOf(': ', start);
  if (separator < 0) return message;
  const location = message.slice(start, separator).replaceAll('\\', '/');
  return engineLocationRoots.some((root) => location.startsWith(root)) ? message.slice(separator + 2) : message;
}
