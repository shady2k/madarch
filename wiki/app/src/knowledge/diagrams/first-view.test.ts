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
  expect(visible).toContain(sparse[0]!);
  expect(visible.length).toBeGreaterThanOrEqual(2);
  for (const t of sparse) {
    const left=fit.x+t.x*fit.zoom, right=left+t.width*fit.zoom, top=fit.y+t.y*fit.zoom, bottom=top+t.height*fit.zoom;
    if(right>0 && left<348 && bottom>0 && top<420) expect(visible).toContain(t);
  }
});
test('empty and single-title diagrams stay bounded and a title wider than the viewport is explicit', () => {
  expect(firstView({x:0,y:0,width:100,height:100},[],348,420,false).readable).toBe(true);
  expect(firstView({x:0,y:0,width:200,height:100},[{x:10,y:10,width:150,height:20,font:14}],348,420,false).readable).toBe(true);
  expect(firstView({x:0,y:0,width:1200,height:1000},[{x:10,y:10,width:1000,height:20,font:11}],100,100,false).readable).toBe(false);
});

test('edge labels are obstacles without lowering the node-title floor', () => { const ts=[{x:20,y:20,width:80,height:20,font:20},{x:20,y:100,width:80,height:20,font:20}]; const edge={x:550,y:20,width:100,height:20,font:8}; const fit=firstView({x:0,y:0,width:1600,height:900},ts,348,420,false,[edge]); expect(fit.readable).toBe(true); expect(fit.zoom*20).toBeGreaterThanOrEqual(11); const left=fit.x+edge.x*fit.zoom,right=left+edge.width*fit.zoom; expect(right<=348 || left>=348 || right<=0).toBe(true); });

test('phone fullscreen can keep a top-left reading window at nine pixels without cut titles', () => {
  const phoneTitles = [{x:20,y:20,width:80,height:20,font:20},{x:20,y:100,width:80,height:20,font:20}];
  const fit = firstView({x:0,y:0,width:5000,height:4000},phoneTitles,348,670,true);
  expect(fit.whole).toBe(false);
  expect(fit.readable).toBe(true);
  expect(fit.zoom * 20).toBeGreaterThanOrEqual(9);
  for (const title of phoneTitles) {
    expect(fit.x + title.x * fit.zoom).toBeGreaterThanOrEqual(0);
    expect(fit.y + title.y * fit.zoom).toBeGreaterThanOrEqual(0);
    expect(fit.x + (title.x + title.width) * fit.zoom).toBeLessThanOrEqual(348);
    expect(fit.y + (title.y + title.height) * fit.zoom).toBeLessThanOrEqual(670);
  }
});

test('desktop fullscreen shows the whole visible diagram at the nine-pixel title floor', () => {
  const fit = firstView({x:0,y:0,width:2400,height:1400},titles,1108,710,true);
  expect(fit.whole).toBe(true);
  expect(fit.readable).toBe(true);
  expect(fit.zoom * 20).toBeGreaterThanOrEqual(9);
  expect(fit.x).toBeGreaterThanOrEqual(0);
  expect(fit.y).toBeGreaterThanOrEqual(0);
  expect(fit.x + 2400 * fit.zoom).toBeLessThanOrEqual(1108);
  expect(fit.y + 1400 * fit.zoom).toBeLessThanOrEqual(710);
});


test('never skips the first content node to report a later cluster as readable', () => {
  const sparse = [{x:20,y:20,width:100,height:20,font:11}, {x:700,y:500,width:100,height:20,font:11}, {x:700,y:600,width:100,height:20,font:11}];
  const fit = firstView({x:0,y:0,width:1000,height:1000}, sparse,348,420,false);
  expect(fit.readable).toBe(false);
  expect(fit.x + sparse[0]!.x * fit.zoom).toBe(12); expect(fit.y + sparse[0]!.y * fit.zoom).toBe(12);
  expect(fit.x + sparse[0]!.x * fit.zoom).toBeGreaterThanOrEqual(0);
});


test('a visible node cannot lose its wholly offscreen title', () => {
  const titles = [
    { x: 20, y: 20, width: 80, height: 20, font: 11, node: { x: 10, y: 10, width: 120, height: 60 } },
    { x: 20, y: 100, width: 80, height: 20, font: 11, node: { x: 10, y: 90, width: 120, height: 60 } },
    { x: 400, y: 200, width: 80, height: 20, font: 11, node: { x: 300, y: 180, width: 200, height: 80 } },
  ];
  const fit = firstView({ x: 0, y: 0, width: 1200, height: 900 }, titles, 348, 420, false);
  expect(fit.readable).toBe(false);
});


test('a large ownership boundary remains readable when its title and first child titles are fully visible', () => {
  const titles = [
    { x: 20, y: 10, width: 100, height: 20, font: 11, node: { x: 0, y: 0, width: 1200, height: 900 } },
    { x: 40, y: 60, width: 80, height: 20, font: 11, node: { x: 20, y: 40, width: 120, height: 70 } },
    { x: 40, y: 160, width: 80, height: 20, font: 11, node: { x: 20, y: 140, width: 120, height: 70 } },
  ];
  const fit = firstView({ x: 0, y: 0, width: 1200, height: 900 }, titles, 348, 420, false);
  expect(fit.readable).toBe(true);
  expect(fit.whole).toBe(false);
  expect(fit.zoom).toBe(1);
});
