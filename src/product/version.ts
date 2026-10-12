/**
 * `madarch version` and the release identity the binary carries (madarch-lfhu):
 * the release build embeds a `version` file (src/product-wiki/release-assets.ts
 * reads it back), and the command answers it as one fact. A source checkout
 * answers `dev`: it has no release version, and `madarch upgrade` refuses
 * there for the same reason.
 */
import { releaseVersion } from '../product-wiki/release-assets.js';

/** The version this process answers with: the release's own, or `dev` in a checkout. */
export function runningVersion(): string {
  return releaseVersion() ?? 'dev';
}
