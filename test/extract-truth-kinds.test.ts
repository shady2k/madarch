import { expect, test } from 'bun:test';
import { starterKinds } from './knowledge-fixture.js';

test('graph-truth-kinds: every new extracted entity has bilingual labels and a description', () => {
  // A container health check holds what the compose healthcheck and the Kubernetes probe said (madarch-64o5.109: one kind).
  for (const name of ['code.metric', 'code.broker', 'container-health-check', 'code.document-section']) {
    const kind = starterKinds().find((entry) => entry.name === name);
    expect(kind, name).toBeDefined(); expect(kind?.en.every(Boolean)).toBe(true); expect(kind?.ru.every(Boolean)).toBe(true);
    expect(kind?.describe?.every(Boolean)).toBe(true);
  }
});
