# Linguist language dataset

`languages.json` is the complete exported dataset from `linguist-languages` **9.5.0**,
including every language and every field. No inventory is filtered or capped.

Source: https://github.com/ikatyang-collab/linguist-languages/tree/v9.5.0
Package: https://www.npmjs.com/package/linguist-languages/v/9.5.0

The runtime reads this single generated file instead of loading hundreds of tiny
JavaScript modules. The root package keeps the exact upstream version for generation
and equality testing. Disk has no runtime dependency on the upstream package.

Regenerate from the repository root:

```sh
bun scripts/generate-disk-languages.ts
bun scripts/generate-disk-languages.ts --check
```

The copied MIT license and upstream third-party notice are in `LANGUAGES-LICENSE`
and `LANGUAGES-THIRD-PARTY-NOTICES.txt`.
