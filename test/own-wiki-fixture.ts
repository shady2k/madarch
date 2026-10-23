/**
 * A stand-in for madarch's own wiki repository (decision 0031): a small product
 * repository in the current format, with the starter set, one page, a glossary
 * and a git history, so the tests of the install, the refresh and the server
 * never reach for the network or for the real repository.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { gitEnv } from './git-env.js';

const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
export const ownGit = (cwd: string, args: string[]): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(identity) });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${result.stderr}`);
  return result.stdout.trim();
};

export const PRODUCT_PAGE = `---
id: product:docs
kind: product
title: Example docs
producer: person
---
The example tool keeps a manifest for every product.[^manifest]

[^manifest]: [Manifest](madarch:doc:docs/reference.md#manifest)
`;

export const GLOSSARY = `# Glossary

- **Manifest** - The file that tells the wiki which kinds a product has.
  - Also called: manifests, kinds file
  - In code: \`madarch/kinds.yaml\`
  - Used in: [the reference](madarch:doc:docs/reference.md#manifest)
- **Payment token** - The proof a provider returns when it captured money.
  - Ambiguous: the documents also use it for the vault reference; see [the open question](madarch:doc:docs/reference.md#question)
- **Capture** - The moment the money is taken from the card.
`;

export const REFERENCE = `# Reference

## Manifest {#manifest}

The manifest lists the kinds.

## Open question {#question}

Which token does the architecture mean?
`;

/** Makes the repository at \`folder\` (a git repository on \`main\`, one commit) and returns it. */
export function makeWikiRepository(folder: string, extra: Record<string, string> = {}): string {
  mkdirSync(join(folder, 'docs'), { recursive: true });
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: example-docs\nname: Example docs\n');
  seedStarterSet(folder);
  writeFileSync(join(folder, 'docs', 'product.md'), PRODUCT_PAGE);
  writeFileSync(join(folder, 'docs', 'glossary.md'), GLOSSARY);
  writeFileSync(join(folder, 'docs', 'reference.md'), REFERENCE);
  for (const [path, text] of Object.entries(extra)) {
    mkdirSync(join(folder, path, '..'), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  ownGit(folder, ['init', '--quiet', '--initial-branch=main']);
  ownGit(folder, ['add', '.']);
  ownGit(folder, ['commit', '--quiet', '-m', 'The example wiki']);
  return folder;
}
