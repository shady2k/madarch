import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = /(?:\.test|\.spec|_test)\.(?:[cm]?[jt]sx?)$/;

export function checkShardCoverage(expectedFiles, shardManifests, expectedShardCount, repositoryRoot = process.cwd(), manifestDirectory = ".", excludedFiles = []) {
  const errors = [];
  if (shardManifests.length !== expectedShardCount) {
    errors.push(`${resolve(repositoryRoot, manifestDirectory)}: expected ${expectedShardCount} shard manifests, found ${shardManifests.length}`);
  }

  const excluded = new Set(excludedFiles);
  const tracked = new Set(expectedFiles);
  for (const file of excluded) {
    if (!tracked.has(file)) errors.push(`the slow list names ${resolve(repositoryRoot, file)}, which is not a tracked test file`);
  }
  const expected = new Set(expectedFiles.filter((file) => !excluded.has(file)));
  const seen = new Set();
  for (const [shard, files] of shardManifests.entries()) {
    for (const file of files) {
      if (excluded.has(file)) {
        errors.push(`shard ${shard + 1} ran ${resolve(repositoryRoot, file)}, which the slow list excludes from the blocking run`);
      } else if (!expected.has(file)) {
        errors.push(`shard ${shard + 1} reported unknown test file ${resolve(repositoryRoot, file)}`);
      }
      if (seen.has(file)) errors.push(`test file ran in more than one shard: ${resolve(repositoryRoot, file)}`);
      seen.add(file);
    }
  }
  for (const file of expected) {
    if (!seen.has(file)) errors.push(`test file ran in no shard: ${resolve(repositoryRoot, file)}`);
  }
  return errors;
}

/** The paths a slow list excludes from the blocking run: `{"files": [{"path": ...}]}`. */
function slowPaths(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.files)) {
    throw new Error(`${path} is not a slow-file list`);
  }
  return parsed.files.map((entry) => {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') {
      throw new Error(`${path} has a slow-file entry with no path`);
    }
    return entry.path;
  });
}

function main() {
  const [artifactDirectory, countText, ...flags] = process.argv.slice(2);
  const shardCount = Number(countText);
  if (!artifactDirectory || !Number.isInteger(shardCount) || shardCount < 1) {
    console.error('Usage: node .shady2k/check-test-shards.mjs <artifact-directory> <shard-count> [--exclude <slow-file-list>]');
    process.exitCode = 2;
    return;
  }
  let excludedFiles = [];
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === '--exclude') {
      const path = flags[index + 1];
      if (path === undefined || path.startsWith('--')) {
        console.error('--exclude names the slow-file list, and none was given');
        process.exitCode = 2;
        return;
      }
      try {
        excludedFiles = slowPaths(path);
      } catch (error) {
        console.error(error.message);
        process.exitCode = 2;
        return;
      }
      index += 1;
    } else {
      console.error(`unknown argument ${JSON.stringify(flag)}`);
      process.exitCode = 2;
      return;
    }
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
  const errors = checkShardCoverage(expectedFiles, shardManifests, shardCount, repositoryRoot, artifactDirectory, excludedFiles);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  const blocking = expectedFiles.filter((file) => !excludedFiles.includes(file)).length;
  console.log(`All ${blocking} blocking test files ran exactly once across ${shardCount} shard${shardCount === 1 ? '' : 's'} (${excludedFiles.length} slow files excluded).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
