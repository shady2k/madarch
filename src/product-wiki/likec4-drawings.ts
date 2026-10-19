/**
 * The drawings a LikeC4 element holds, found through the shadow roots LikeC4 nests
 * (madarch-pdkl; decision 0026, "Diagrams"): the page the LikeC4 tab frames
 * (`graph-render.ts`, `graphLikeC4Page`) asks it to say in words that a browser drew
 * nothing, and the acceptance walk (`test/wiki-graph-diagrams-e2e.test.ts`) asks it
 * how many drawings, and how many labels, the browser really drew.
 *
 * It is one function because the question is one question, and because the wrong
 * answer to it was a bug: LikeC4's webcomponent attaches a shadow root of its own
 * (`<prefix>-view`), and inside that root its React tree puts the drawing in a
 * *second*, nested shadow root (`<div class="likec4-shadow-root">`, the
 * `ShadowRootHost` of `likec4/react`). `element.shadowRoot.querySelector('svg')`
 * therefore finds nothing however well LikeC4 draws — measured on the pod with the
 * bug's own five-line workspace: 0 svgs in the element's shadow root, and 1 svg one
 * level deeper — so the page announced a drawing nobody lacked and the walk recorded
 * `svgs: 0`.
 *
 * What it answers, exactly: every svg in the element's composed tree. LikeC4's own
 * chrome (the icons of its controls) lives in the same tree, so a page holding an icon
 * and no drawing is not told it drew — the walk's labels, not this count alone, are
 * what say a reader has a diagram, because a drawing that carries no text is no
 * diagram a person reads.
 *
 * The source is a plain function expression so both callers run exactly these bytes:
 * the page inlines them into its own classic script, and the walk evaluates them in
 * the frame it measures. It walks the composed tree — the host element, its own open
 * shadow root and every shadow root inside it, at any depth — and answers with the
 * drawings (the svgs) it found.
 */
export const LIKEC4_DRAWINGS_SOURCE = `function (root) {
  var found = [];
  var queue = [root];
  while (queue.length > 0) {
    var node = queue.shift();
    if (!node || !node.querySelectorAll) continue;
    var held = node.querySelectorAll('svg');
    for (var at = 0; at < held.length; at++) found.push(held[at]);
    var inside = node.querySelectorAll('*');
    for (var child = 0; child < inside.length; child++) {
      if (inside[child].shadowRoot) queue.push(inside[child].shadowRoot);
    }
    if (node.shadowRoot) queue.push(node.shadowRoot);
  }
  return found;
}`;
