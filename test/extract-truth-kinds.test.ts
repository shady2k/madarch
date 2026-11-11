import { expect, test } from 'bun:test';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { starterKinds } from './knowledge-fixture.js';
test('graph-truth-kinds: every new extracted entity has bilingual labels and an existing generic page template', () => {
 for (const name of ['code.metric', 'code.broker', 'code.probe', 'code.healthcheck', 'code.document-section']) {
  const kind = starterKinds().find((entry) => entry.name === name);
  expect(kind, name).toBeDefined(); expect(kind?.en.every(Boolean)).toBe(true); expect(kind?.ru.every(Boolean)).toBe(true);
  expect(kind?.describe?.every(Boolean)).toBe(true);
  expect(STARTER_FILES.some((entry) => entry.path === `templates/${kind?.template}`)).toBe(true);
 }
});
