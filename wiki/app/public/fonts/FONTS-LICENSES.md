# Font licences shipped by the madarch wiki

Everything under `wiki/app/public/fonts/` is third-party font software,
redistributed under the SIL Open Font License, Version 1.1. This file lists
every shipped face, where it came from, and what madarch ships of it. The
licence texts are copied verbatim from the upstream repositories and sit
beside the faces they cover; they are not modified.

## Inter Variable (upright)

- Upstream: [rsms/inter](https://github.com/rsms/inter), release
  [v4.1](https://github.com/rsms/inter/releases/tag/v4.1), asset `Inter-4.1.zip`,
  file `web/InterVariable.woff2` inside that asset.
- Shipped as: `public/fonts/InterVariable.woff2` (sha-256 starts `693b77d4f32ee9b8`).
- Format: WOFF2 variable font, axes `opsz` 14-32 and `wght` 100-900, upright
  only. Upstream serves latin, cyrillic, cyrillic-ext, greek and vietnamese
  subsets from this single file; coverage was verified against the release
  file itself (code points U+0410, U+0430, U+0401, U+0462 present).
- Licence: SIL Open Font License 1.1, upstream
  [`LICENSE.txt`](https://github.com/rsms/inter/blob/v4.1/LICENSE.txt),
  shipped verbatim as `public/fonts/Inter-OFL.txt`.

## Inter Variable (italic)

- Upstream: same release as above, file `web/InterVariable-Italic.woff2` inside
  `Inter-4.1.zip`.
- Shipped as: `public/fonts/InterVariable-Italic.woff2` (sha-256 starts
  `e564f652916db6c1`).
- Format: WOFF2 variable font, same axes, italic. Verified to cover cyrillic
  the same way as the upright face.
- Licence: SIL Open Font License 1.1, same `LICENSE.txt`, covered by the same
  `public/fonts/Inter-OFL.txt`.

## JetBrains Mono Regular

- Upstream: [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono),
  release [v2.304](https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304),
  asset `JetBrainsMono-2.304.zip`, file `fonts/webfonts/JetBrainsMono-Regular.woff2`
  inside that asset.
- Shipped as: `public/fonts/JetBrainsMono-Regular.woff2` (sha-256 starts
  `a9cb1cd82332b23a`).
- Format: WOFF2 static, weight 400. Covers latin, latin-ext, cyrillic
  (verified U+0410, U+0430, U+0401) and greek; it does not carry the
  cyrillic-ext code points (e.g. U+0462), which upstream does not include in
  this webfont either.
- Licence: SIL Open Font License 1.1, upstream
  [`OFL.txt`](https://github.com/JetBrains/JetBrainsMono/blob/v2.304/OFL.txt),
  shipped verbatim as `public/fonts/JetBrainsMono-OFL.txt`.

## JetBrains Mono Bold

- Upstream: same release as above, file `fonts/webfonts/JetBrainsMono-Bold.woff2`
  inside `JetBrainsMono-2.304.zip`.
- Shipped as: `public/fonts/JetBrainsMono-Bold.woff2` (sha-256 starts
  `c503cc5ec5f8b2c7`).
- Format: WOFF2 static, weight 700. Same coverage and licence as the Regular.
- Licence: SIL Open Font License 1.1, covered by the same
  `public/fonts/JetBrainsMono-OFL.txt`.

## What madarch does not ship

- The remaining static weights and the display faces from both releases.
- A separate italic for JetBrains Mono (the wiki does not style code as
  italic; the browser synthesizes one if it is ever asked for).
- No other face is modified: the files are byte-identical copies of the
  release artefacts.
