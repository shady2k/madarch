/**
 * The picture's fit, zoom and pan (madarch-64o5.96): each case below is one the review found broken — the fit ignored
 * the box's height, zooming out enlarged a tiny fit, and a 2 000 px picture at 75 % refused every drag.
 */
import { expect, test } from 'bun:test';
import { fitScale, pans, zoomStep } from './diagram-zoom.js';

test('the fit shows the picture whole: a tall picture fits the box\'s height too', () => {
  // 600 × 1600 in an 800 px-wide box whose height cap is 648 px: the width alone would say 1.
  expect(fitScale({ width: 600, height: 1600 }, { width: 800, height: 648 })).toBeCloseTo(646 / 1600, 3);
  expect(fitScale({ width: 400, height: 200 }, { width: 800, height: 648 })).toBe(1);
});

test('zooming out never enlarges: a fit of 11 % steps to 9 %, not to 20 %', () => {
  expect(zoomStep(0.11, 1 / 1.25)).toBe(0.09);
  expect(zoomStep(0.75, 1 / 1.25)).toBe(0.6);
  expect(zoomStep(1, 1.25)).toBe(1.25);
  expect(zoomStep(3.5, 1.25)).toBe(4);
});

test('a picture larger than its box pans, whatever its scale', () => {
  // 2 000 px at 75 % is 1 500 px in a 390 px box: a drag must pan it though the scale is below 1.
  expect(pans({ width: 2000, height: 300 }, 0.75, { width: 390, height: 800 })).toBe(true);
  expect(pans({ width: 2000, height: 300 }, 0.3, { width: 390, height: 800 })).toBe(true);
  expect(pans({ width: 200, height: 100 }, 1, { width: 390, height: 800 })).toBe(false);
});
