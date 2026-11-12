/** The fill's one stage list, shared by every caller of runFill. */
import { createEngineStageRegistry } from './stages/index.js';

/** Ordinary declared plugins are the only fill execution stage. */
const FILL_STEP_IDS = ['plugin-turns'] as const;

export function fillSteps(): readonly string[] {
  return [...FILL_STEP_IDS];
}

let writesPages: boolean | undefined;

/** Whether the declared fill stage can drive tools and write pages. */
export function fillWritesPages(): boolean {
  if (writesPages === undefined) {
    const steps = new Set(fillSteps());
    writesPages = createEngineStageRegistry().all().some((stage) => steps.has(stage.id) && stage.usesTools === true);
  }
  return writesPages;
}
