/** Actual-binary first-view title geometry (madarch-m38l.15, coordinator review 5). */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
const url = process.argv[2];
if (!url) throw new Error('usage: bun scripts/archify-geometry-check.ts <binary archify frame URL>');
const browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  for (const [width, height, full] of [[792,540,false], [348,420,false], [1124,710,true], [364,710,true]] as const) {
    await page.setViewport({ width, height });
    await page.goto(`${url}&fullscreen=${full ? 1 : 0}`);
    await page.waitForSelector('.diagram-container > svg');
    const result = await page.evaluate(async () => {
      await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      const svg = document.querySelector<SVGSVGElement>('.diagram-container > svg')!;
      const texts = [...svg.querySelectorAll<SVGTextElement>('text[data-node-label]')];
      const boxes = texts.map((n) => ({ text: n.textContent, r: n.getBoundingClientRect(), source: parseFloat(getComputedStyle(n).fontSize), px: parseFloat(getComputedStyle(n).fontSize) * n.getScreenCTM()!.a }));
      const visible = boxes.filter(({r}) => r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight);
      const clipped = boxes.filter(({r}) => r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight && !(r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight));
      const box = svg.viewBox.baseVal, area = svg.parentElement!;
      const possible = Math.min((area.clientWidth - 24) / box.width, (area.clientHeight - 24) / box.height) * Math.min(...boxes.map(n => n.source)) >= (new URLSearchParams(location.search).get('fullscreen') === '1' ? 9 : 11);
      return { possible, whole: svg.getAttribute('data-whole-fit'), scale: svg.getAttribute('data-initial-scale'), smallestTitlePx: Math.min(...boxes.map((n) => n.px)), visible: visible.map((n) => n.text), total: boxes.length, clipped: clipped.map((n) => n.text), scrollLeft: svg.parentElement!.scrollLeft, scrollTop: svg.parentElement!.scrollTop };
    });
    console.log(JSON.stringify({ width, height, full, ...result }));
    assert.equal(result.whole === 'true', result.possible);
    if (result.possible) assert.equal(result.visible.length, result.total);
    assert.ok(result.smallestTitlePx >= (full ? 9 : 11) - 0.01);
    assert.equal(result.clipped.length, 0, 'no initial node title may be cut');
    assert.ok(result.visible.length >= Math.min(2,result.total), 'at least two complete titles');
    assert.equal(result.scrollLeft, 0); assert.equal(result.scrollTop, 0);
  }
} finally { await browser.close(); }
