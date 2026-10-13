import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync, constants as fsConstants } from 'node:fs';
import { join as joinPath } from 'node:path';

/** Open a registry without blocking on special files, then validate the opened descriptor. */
export function readRegistryFileSafely(file: string, productFolder: string, relative: string): Buffer {
  const expected = joinPath(realpathSync(productFolder), ...relative.split('/'));
  const namedPath = realpathSync(file);
  if (namedPath !== expected) {
    throw new Error(`the registry file is a symlink the product does not hold: it points at ${namedPath}, away from the place madarch reads`);
  }

  const descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new Error(opened.isDirectory()
      ? `${relative} is a folder, not a registry file`
      : `${relative} is not a regular file, so the wiki does not open it`);

    // Re-resolve the name after open, then compare its identity with the
    // descriptor. This is portable and refuses a symlink swap without reading it.
    const reopenedPath = realpathSync(file);
    if (reopenedPath !== expected) {
      throw new Error(`the registry file is a symlink the product does not hold: it points at ${reopenedPath}, away from the place madarch reads`);
    }
    const named = statSync(reopenedPath);
    if (named.dev !== opened.dev || named.ino !== opened.ino) {
      throw new Error(`${relative} changed while the wiki was opening it; the registry file was not read`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
