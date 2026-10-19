/**
 * The LikeC4 page's watchdog, as one source string the page inlines and a test
 * drives (madarch-pdkl): a page that drew nothing says so in words instead of showing
 * an empty frame, and it says so only when it really drew nothing.
 *
 * madarch-tzte.23.4 wrote the page's sentence without a way to take it back: it
 * sampled once, 8 seconds in, over a browser where the wrong shadow root had been
 * read (`likec4-drawings.ts`). The page therefore watches instead: a tick of
 * `LIKEC4_WATCH_TICK_MS` from the page's `load`, the sentence
 * `LIKEC4_WATCH_GRACE_MS` in without a drawing, the sentence taken away when a
 * drawing appears later — a slow first paint must not leave words over a picture —
 * and the watching over at `LIKEC4_WATCH_END_MS`, so a page left open holds no timer.
 * A drawing that arrives after that bound leaves the sentence where it stands: the
 * page has stopped looking, and a reader who waits two minutes can reload it.
 *
 * The source is written for the two worlds that run it: the page (where `window`,
 * `document` and `Date` are the browser's) and `test/graph-diagrams-render.test.ts`
 * (where they are stand-ins and the clock is the test's own). It therefore takes
 * everything it touches from those names and nothing from the module, and it never
 * throws out of a tick: a check that throws is a page that drew nothing it can show.
 */

/** The cadence of the watch: often enough to take a sentence away from a slow first paint. */
export const LIKEC4_WATCH_TICK_MS = 250;
/** How long a drawing is given before the page says it drew nothing: eight seconds, the bound madarch-tzte.23.4 chose. */
export const LIKEC4_WATCH_GRACE_MS = 8000;
/** The last moment the page watches: two minutes, so a page left open holds no timer for a drawing that never comes. */
export const LIKEC4_WATCH_END_MS = 120_000;

/** The words a page's sentence carries: the element it watches and the diagram's title. */
export interface LikeC4WatchWords {
  /** The custom element's own name, as the page writes it. */
  readonly name: string;
  /** The diagram's title, as the model spells it. */
  readonly title: string;
}

/**
 * The watchdog of one LikeC4 page, as the classic script the page carries after the
 * bundle. It expects `likec4Drawings` (the walk of `likec4-drawings.ts`) in scope, and
 * asks `window`, `document` and `Date` for everything else.
 */
export function likec4WatchSource(words: LikeC4WatchWords): string {
  return `(function () {
  var name = ${JSON.stringify(words.name)};
  var started = Date.now();
  var said = null;
  var timer = window.setInterval(function () {
    try {
      var element = document.querySelector(name);
      var drawings = element === null ? [] : likec4Drawings(element);
      if (drawings.length > 0) {
        if (said !== null) { said.remove(); said = null; }
        window.clearInterval(timer);
        return;
      }
      var waited = Date.now() - started;
      if (waited >= ${String(LIKEC4_WATCH_END_MS)}) { window.clearInterval(timer); return; }
      if (waited < ${String(LIKEC4_WATCH_GRACE_MS)} || said !== null) return;
      // The sentence names what this page can really see: whether the element was ever defined, and whether it
      // holds a drawing. A bundle that never arrived is another failure than a view that stands empty.
      var defined = !!(window.customElements && window.customElements.get(name));
      said = document.createElement('p');
      said.setAttribute('data-likec4-undrawn', defined ? 'empty' : 'not-loaded');
      said.style.cssText = 'margin: 1em; font: 14px/1.5 system-ui, sans-serif; color: #333;';
      said.textContent = (defined
        ? ${JSON.stringify(`LikeC4's element is defined and its view of ${words.title} stands empty in this browser.`)}
        : ${JSON.stringify(`LikeC4's bundle did not load, so ${words.title} has no drawing to show.`)}
      ) + ' The Mermaid and archify tabs draw the same model.';
      document.body.appendChild(said);
    } catch (error) {
      // A check that throws drew nothing this page can show: the watch keeps its cadence and still ends on time.
      if (Date.now() - started >= ${String(LIKEC4_WATCH_END_MS)}) window.clearInterval(timer);
    }
  }, ${String(LIKEC4_WATCH_TICK_MS)});
})();`;
}
