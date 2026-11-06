/** Scripted interpretation of one held neutral source fixture, never source or execution authority. */
import type { GuideContext, GuideDocument, GuideGround, GuideKind } from '../src/writer/guides/model.js';
import type { GuideContextPage } from '../src/writer/guides/prepared.js';
import { guideDigest } from '../src/writer/guides/digest.js';

export const SCRIPTED_GUIDE_PATH = 'docs/scripted-guide-check.md';
export const SCRIPTED_GUIDE_COMMAND = 'node -e "console.log(7)"';
export const SCRIPTED_GUIDE_OBSERVATION = '7';
export const SCRIPTED_GUIDE_PARAGRAPH = `Run \`${SCRIPTED_GUIDE_COMMAND}\` from the repository root in an isolated fixture environment. Expected exit status: 0. Expected output: ${SCRIPTED_GUIDE_OBSERVATION}.`;
export const SCRIPTED_GUIDE_SOURCE = `# Fixture readiness check\n\n${SCRIPTED_GUIDE_PARAGRAPH}\n`;
