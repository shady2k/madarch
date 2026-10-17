/**
 * The fill's product configuration read (decision 0027): `fill.stages.<id>`
 * in the product's own configuration file enables, disables and limits a
 * stage of the fill.
 *
 * The file is the product's manifest, `workspace.yaml` (decision 0021): it
 * is the product's configuration file madarch's own code reads, it is
 * versioned in the product's git the way decision 0027 asks, and a field
 * the manifest's reader does not know is ignored, so a product declaring
 * `fill.stages` still opens in a madarch older than the fill. The kinds
 * registry at `docs/kinds.yaml` is deliberately not the place: it is the
 * skill set's document contract, and its stage list names the wiki's
 * lifecycle stages, which decision 0027 keeps apart from the fill's
 * processing stages.
 *
 * The manifest's own parser (`parseManifest`) reads the file, so the two
 * readers can never disagree about what the manifest says. Every refusal
 * names the full path of the file, the 1-based line and the field's path
 * from the top (`fill.stages.inventory`).
 *
 * This reader judges the file and the shape of `fill.stages`: a manifest
 * that is no mapping, a `fill` section that is no mapping, a `fill.stages`
 * that is no mapping, and a key that is no stage id are refused here. The
 * entries themselves are read as the file wrote them and judged by the
 * registry (`src/fill/registry.ts`), which is the only holder of the stages
 * and of their `configSchema`: an entry for a stage this madarch does not
 * hold is therefore never judged, and a product's configuration written for
 * a later madarch still opens, the manifest's own rule for a field it does
 * not know.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lineOf, MANIFEST_FILE, parseManifest } from '../product/manifest.js';
import { STAGE_ID_PATTERN } from './stage.js';

/** One problem found in the product's fill configuration, named where it stands. */
export interface FillConfigError {
  /** The full path of the manifest the problem stands in. */
  file: string;
  /** 1-based line in that file. */
  line: number;
  /** The field's path from the file's top, like `fill.stages.inventory`. */
  path: string;
  message: string;
}

/** What reading the product's fill configuration gave. */
export type FillStageConfigurationRead =
  | {
    ok: true;
    /** The full path of the manifest read, named by every refusal a stage's own configuration raises. */
    file: string;
    /** Each stage the product configures, by stage id, exactly as the manifest wrote it; the registry judges it. */
    stages: Record<string, unknown>;
    /** The 1-based line each `fill.stages.<id>` stands on, by stage id, so a later refusal names its line. */
    lines: Record<string, number>;
  }
  | { ok: false; errors: FillConfigError[] };

/** A refusal of the whole configuration, at the file's own line. */
const refused = (file: string, line: number, path: string, message: string): { ok: false; errors: FillConfigError[] } =>
  ({ ok: false, errors: [{ file, line, path, message }] });

/** How one parsed value stands in a refusal: as YAML would read it back. */
function shown(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}

/**
 * Reads the product's fill configuration, fresh, from the product folder.
 * A folder holding no manifest, and a manifest naming no `fill` section,
 * read as a product that configures no stage: every stage keeps its own
 * defaults. A manifest that does not read refuses the configuration whole —
 * the manifest's own refusal, at its own line — since the same file standing
 * damaged cannot be half trusted for the fill.
 */
export function readFillStageConfiguration(productFolder: string): FillStageConfigurationRead {
  const file = join(resolve(productFolder), MANIFEST_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, file, stages: {}, lines: {} };
    return refused(file, 1, '', `${file} could not be read: ${(error as Error).message}`);
  }
  const parsed = parseManifest(text, file);
  if (!parsed.ok) return refused(file, parsed.line, '', parsed.message);
  const value = parsed.value as unknown;

  // The manifest's own rule, read the same way `readProduct` reads it: the
  // file is a mapping of fields, and a `fill` or a `fill.stages` written but
  // left empty configures nothing.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return refused(file, 1, '', `the manifest ${file} holds ${shown(value)}: a manifest is a mapping of fields, and this is not one`);
  }
  const fields = value as Record<string, unknown>;
  const fill = fields['fill'];
  if (fill === undefined || fill === null) return { ok: true, file, stages: {}, lines: {} };
  if (typeof fill !== 'object' || Array.isArray(fill)) {
    return refused(file, lineOf(fields, 'fill'), 'fill', `fill is a mapping of the fill's own keys, not ${shown(fill)}`);
  }
  const fillMap = fill as Record<string, unknown>;
  const stages = fillMap['stages'];
  if (stages === undefined || stages === null) return { ok: true, file, stages: {}, lines: {} };
  if (typeof stages !== 'object' || Array.isArray(stages)) {
    return refused(file, lineOf(fillMap, 'stages'), 'fill.stages', `fill.stages is a mapping of stage ids to their configuration, not ${shown(stages)}`);
  }

  const stagesMap = stages as Record<string, unknown>;
  const errors: FillConfigError[] = [];
  const read: Record<string, unknown> = {};
  const lines: Record<string, number> = {};
  for (const id of Object.keys(stagesMap)) {
    if (!STAGE_ID_PATTERN.test(id)) {
      errors.push({
        file,
        line: lineOf(stagesMap, id),
        path: `fill.stages.${id}`,
        message: `"${id}" is not a stage id: a stage id starts with a letter and carries letters, digits, ".", "_" or "-"`,
      });
      continue;
    }
    read[id] = stagesMap[id];
    lines[id] = lineOf(stagesMap, id);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, file, stages: read, lines };
}
