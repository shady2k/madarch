# GitHub Linguist's heuristics data

`heuristics.yml` is copied verbatim from **github-linguist v9.7.0**, `lib/linguist/heuristics.yml`
(published 2026-08-26; the file as released at that tag), and is read as data — never re-implemented
as rules of ours.

- sha256: `7fb4f1df1f8dead4bf12e3b408085f90144d3719f35db206756d762aa046aff1`
- Why v9.7.0: the language dataset this repository pins, `linguist-languages@9.5.0` (MIT, pinned in
  `package.json`), carries v9.7.0's `languages.yml` exactly — 833 languages, and every language's
  `extensions` and `filenames` compared equal. A test in `test/language-heuristics.test.ts` keeps the
  two in step: every language a rule names is a language of the dataset, and every extension a rule
  keys on is an extension the dataset knows.
- How it is read: `src/fill/stages/language-heuristics.ts` evaluates the ordered rules with the
  Oniguruma engine (`vscode-oniguruma`, the engine Ruby's `Regexp` is built on), over the first
  50 KiB of a text file's bytes (`HEURISTICS_CONSIDER_BYTES` in linguist's `heuristics.rb`).
- License: github-linguist is MIT; the data is used under that license.
