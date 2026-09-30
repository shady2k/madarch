# Vendored: archify renderer, v3.0.1

This folder holds archify's renderer, kept unmodified inside madarch so the
wiki can render one architecture document per LikeC4 view without a second
install (docs/changes/wiki/change.md, "Design and decisions": the renderer
is pinned at 3.0.1, MIT licensed, and the positions and sizes come from the
view LikeC4 laid out).

- **Source:** https://github.com/tt-a1i/archify — release tag `v3.0.1`,
  commit `2ab3cae7ac2c2a55d7386ca789d03c4fcd31816c`
  (merge of PR #611, "release-v3.0.1").
- **Included** (exactly what rendering one document needs, nothing else):
  - `renderers/architecture/` — the architecture renderer
    (`render-architecture.mjs` and its grid, label and routing modules).
  - `renderers/shared/` — the renderer support library it imports
    (schema validation, output staging, i18n, text fit, geometry, ...).
  - `schemas/` — the JSON Schemas the validators were generated from.
  - `assets/template.html` (+ its font licence) — the self-contained HTML
    template the renderer fills.
  - `package.json` — upstream's own, carrying the 3.0.1 version.
  - `LICENSE`, `THIRD_PARTY_NOTICES.md` — upstream's, unmodified.
- **Runtime:** plain Node (fs/path/url/crypto), no npm dependencies; the
  wiki runs `renderers/architecture/render-architecture.mjs` with one
  document in, one self-contained HTML out.
- **Not included:** archify's CLI (`bin/`), viewer, website, examples,
  benchmarks and the other diagram types' renderers — the wiki renders
  architecture documents only.
- Every file here is byte-identical to the tag's tree (`git archive
  v3.0.1`); the only files not upstream are this README.
