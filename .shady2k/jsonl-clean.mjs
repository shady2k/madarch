#!/usr/bin/env node
// git clean filter for .beads/issues.jsonl: br records the absolute workspace
// path of every issue in source_repo_path. The committed copy stores "." so the
// public history carries no machine-specific path; the working file is untouched.
// In a fresh clone, `br sync --migrate-source-repo-path` restores local paths.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  process.stdout.write(input.replace(/"source_repo_path":"(?:[^"\\]|\\.)*"/g, '"source_repo_path":"."'));
});
