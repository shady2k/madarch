import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = /(?:\.test|\.spec|_test)\.(?:[cm]?[jt]sx?)$/;

export function checkShardCoverage(expectedFiles, shardManifests, expectedShardCount, repositoryRoot = process.cwd(), manifestDirectory = ".") {
  const errors = [];
  if (shardManifests.length !== expectedShardCount) {
    errors.push(`${resolve(repositoryRoot, manifestDirectory)}: expected ${expectedShardCount} shard manifests, found ${shardManifests.length}`);
  }

  const expected = new Set(expectedFiles);
  const seen = new Set();
  for (const [shard, files] of shardManifests.entries()) {
    for (const file of files) {
      if (!expected.has(file)) errors.push(`shard ${shard + 1} reported unknown test file ${resolve(repositoryRoot, file)}`);
      if (seen.has(file)) errors.push(`test file ran in more than one shard: ${resolve(repositoryRoot, file)}`);
      seen.add(file);
    }
  }
  for (const file of expected) {
    if (!seen.has(file)) errors.push(`test file ran in no shard: ${resolve(repositoryRoot, file)}`);
  }
  return errors;
}

function main() {
  const [artifactDirectory, countText] = process.argv.slice(2);
  const shardCount = Number(countText);
  if (!artifactDirectory || !Number.isInteger(shardCount) || shardCount < 1) {
    console.error('Usage: node .shady2k/check-test-shards.mjs <artifact-directory> <shard-count>');
    process.exitCode = 2;
    return;
  }

  const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const expectedFiles = execFileSync('git', ['ls-files', '-z', '--', 'test'], { encoding: 'utf8' })
    .split('\0')
    .filter((path) => TEST_FILE.test(path))
    .sort();
  if (expectedFiles.length === 0) {
    console.error(`${resolve(repositoryRoot, 'test')}: no tracked root test files were found.`);
    process.exitCode = 1;
    return;
  }
  const manifestPaths = readdirSync(artifactDirectory)
    .filter((name) => /^shard-\d+\.json$/.test(name))
    .sort();
  const shardManifests = manifestPaths.map((name) => {
    const path = join(artifactDirectory, name);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot read Bun test shard manifest ${resolve(path)}: ${error.message}`);
    }
    if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
      throw new Error(`${resolve(path)} is not a Bun test timings file`);
    }
    return Object.keys(manifest.files).sort();
  });
  const errors = checkShardCoverage(expectedFiles, shardManifests, shardCount, repositoryRoot, artifactDirectory);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log(`All ${expectedFiles.length} root test files ran exactly once across ${shardCount} shards.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
