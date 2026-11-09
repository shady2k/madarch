/** Neutral held fixture: actual publication + default KnowledgeProduct read factory. No execution attestation is manufactured here. */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore } from '../src/graph/index.js';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { storeFolderOf } from '../src/product/store.js';
import { createKnowledgePart } from '../src/server/knowledge.js';
import { guideProductPin } from '../src/writer/guides/writer.js';
import { firstGuideCursor, readGuidePageContext } from '../src/writer/guides/prepared.js';
import { GUIDE_OUTPUTS, registeredGuideOutput } from '../src/writer/guides/host-contract.js';
import { GUIDE_SCHEMA, type GuideGround } from '../src/writer/guides/model.js';
import { validateGuide } from '../src/writer/guides/validate.js';
import { renderGuideArtifact } from '../src/writer/guides/artifact.js';
import type { UnitAgent } from '../src/writer/run.js';
import type { PageModel } from '../src/knowledge/model.js';
import { gitEnv } from './git-env.js';
import { createTestDatabaseOwner } from './test-database.js';

const env = gitEnv({ GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' });
const instruction = 'node -e "console.log(\'Ready\')"';
const observation = 'Ready';
const source = `# Status check\n\nRun \`${instruction}\` from the repository root in an isolated environment. Expected exit status: 0. Expected output: Ready.\n`;
const vision = `# Operator and reader\n\nBoth roles can read readiness. Run \`${instruction}\` from the repository root in an isolated environment. Expected exit status: 0. Expected output: Ready.\n`;
const valid = '2026-04-01T00:00:00Z';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const commit = (cwd: string, message: string) => { git(cwd, 'add', '.'); git(cwd, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message); return git(cwd, 'rev-parse', 'HEAD'); };
const guideBlock = (page: PageModel) => {
  const block = page.blocks.find((entry) => entry.type === 'guide');
  if (block?.type !== 'guide') throw new Error(JSON.stringify(page.findings));
  return block;
};

