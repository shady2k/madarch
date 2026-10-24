import { expect, test } from 'bun:test';
import { firstView } from './first-view.js';
const titles = [{ x: 20, y: 20, width: 100, height: 20, font: 20 }, { x: 20, y: 160, width: 100, height: 20, font: 20 }];
test('fits the whole diagram when node titles stay at eleven pixels', () => {
  const fit = firstView({ x: 0, y: 0, width: 800, height: 500 }, titles, 792, 540, false);
  expect(fit.whole).toBe(true); expect(fit.zoom * 20).toBeGreaterThanOrEqual(11);
});
test('anchors unreadable whole-fit at top left and keeps at least two complete titles', () => {
  const fit = firstView({ x: -30, y: -40, width: 1800, height: 1600 }, titles, 348, 420, false);
  expect(fit.whole).toBe(false); expect(fit.x - 30 * fit.zoom).toBe(12); expect(fit.y - 40 * fit.zoom).toBe(12);
  for (const t of titles) { expect(fit.x + (t.x + t.width) * fit.zoom).toBeLessThanOrEqual(348); expect(fit.y + (t.y + t.height) * fit.zoom).toBeLessThanOrEqual(420); }
});
test('fullscreen lowers only the title floor to nine for an overview', () => {
  const bounds = { x: 0, y: 0, width: 1600, height: 900 };
  expect(firstView(bounds, titles, 800, 600, false).whole).toBe(false);
  const full = firstView(bounds, titles, 800, 600, true);
  expect(full.whole).toBe(true); expect(full.zoom * 20).toBeGreaterThanOrEqual(9);
});

test('whole fit permits upscaling a small native title', () => { const fit = firstView({x:0,y:0,width:200,height:100}, [{x:10,y:10,width:80,height:20,font:8}],792,540,false); expect(fit.whole).toBe(true); expect(fit.zoom * 8).toBeGreaterThanOrEqual(11); });

test('a sparse first row chooses the earliest top-left content window without cut titles', () => {
  const sparse = [{x:483,y:32,width:53,height:14,font:11}, {x:268,y:194,width:53,height:14,font:11}, {x:53,y:363,width:53,height:14,font:11}, {x:245,y:363,width:99,height:14,font:11}];
  const fit = firstView({x:0,y:0,width:872,height:812}, sparse, 348,420,false);
  expect(fit.readable).toBe(true);
  const visible = sparse.filter(t => fit.x+t.x*fit.zoom>=0 && fit.x+(t.x+t.width)*fit.zoom<=348 && fit.y+t.y*fit.zoom>=0 && fit.y+(t.y+t.height)*fit.zoom<=420);
  expect(visible.length).toBeGreaterThanOrEqual(2);
});
test('empty and single-title diagrams stay bounded and a title wider than the viewport is explicit', () => {
  expect(firstView({x:0,y:0,width:100,height:100},[],348,420,false).readable).toBe(true);
  expect(firstView({x:0,y:0,width:200,height:100},[{x:10,y:10,width:150,height:20,font:14}],348,420,false).readable).toBe(true);
  expect(firstView({x:0,y:0,width:1200,height:1000},[{x:10,y:10,width:1000,height:20,font:11}],100,100,false).readable).toBe(false);
});

test('edge labels are obstacles without lowering the node-title floor', () => { const ts=[{x:20,y:20,width:80,height:20,font:20},{x:20,y:100,width:80,height:20,font:20}]; const edge={x:550,y:20,width:100,height:20,font:8}; const fit=firstView({x:0,y:0,width:1600,height:900},ts,348,420,false,[edge]); expect(fit.readable).toBe(true); expect(fit.zoom*20).toBeGreaterThanOrEqual(11); const left=fit.x+edge.x*fit.zoom,right=left+edge.width*fit.zoom; expect(right<=348 || left>=348 || right<=0).toBe(true); });

test('fullscreen dense reading window keeps the nine-pixel title floor', () => { const fit=firstView({x:0,y:0,width:5000,height:4000},[{x:20,y:20,width:80,height:20,font:20},{x:20,y:100,width:80,height:20,font:20}],348,420,true); expect(fit.whole).toBe(false); expect(fit.zoom*20).toBeGreaterThanOrEqual(9); });
