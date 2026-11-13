import { expect, test } from 'bun:test';
import { wikiRouteOf, addressOfFillRun } from './routes.js';

test('a selected fill has its own reloadable run address', () => {
  expect(addressOfFillRun('run / one')).toBe('/fill/runs/run%20%2F%20one');
  expect(wikiRouteOf('/fill/runs/run%20%2F%20one')).toEqual({ name: 'fill-run', run: 'run / one' });
});
