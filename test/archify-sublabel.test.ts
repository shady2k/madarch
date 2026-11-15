import { expect, test } from 'bun:test';
import { archifySublabel } from '../src/render/diagram.js';

test('a middle-shortened sublabel has room inside its card at the renderer\'s preferred 9 px', () => {
  const deep = `/src/${'nested/'.repeat(20)}index.ts`;
  const sublabel = archifySublabel(deep, 312);
  expect(sublabel).not.toBe(deep);
  expect(sublabel).toContain('…');
  // The renderer draws a sublabel at 9 px when it fits; it must not start at the card's edge.
  expect(sublabel.length * 9 * 0.6).toBeLessThanOrEqual(312 - 8);
  expect(archifySublabel('/src/deep/cloud-resource.yaml', 312)).toBe('/src/deep/cloud-resource.yaml');
});
