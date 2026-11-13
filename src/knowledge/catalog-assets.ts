/** The repository catalogue, embedded as data rather than kind declarations in code. */
import { catalogFiles } from './catalog-files.js' with { type: 'macro' };

export const CATALOG_FILES: Readonly<Record<string, string>> = catalogFiles();
