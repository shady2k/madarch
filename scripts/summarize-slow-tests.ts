#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readSlowList, testFiles } from './run-tests.js';

const [timingsPath, logPath] = process.argv.slice(2);
if (!timingsPath || !logPath || !process.env.GITHUB_STEP_SUMMARY) {
  console.error(`${import.meta.path}:1: expected timings, log and GITHUB_STEP_SUMMARY`);
  process.exit(2);
}
const slow = readSlowList(process.cwd(), testFiles(process.cwd()));
const files: Record<string, number> = existsSync(timingsPath) ? JSON.parse(readFileSync(timingsPath, 'utf8')).files : {};
const independent: Record<string, number> = JSON.parse(readFileSync('.github/workflows/single-file-timings.json', 'utf8')).files;
const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
const lines = [`## Slow tests: ${process.env.SLOW_OUTCOME ?? 'unknown'}`, '', '| Path | Measured seconds | Listed seconds | Result |', '|---|---:|---:|---|'];
let total = 0;
let listedTotal = 0;
for (const entry of slow.files) {
  const ms = files[entry.path];
  listedTotal += entry.seconds;
  if (Number.isFinite(ms)) total += ms!;
  // Bun's per-file result lines belong to the file heading immediately above them.
  const heading = log.indexOf(`\n${entry.path}:`);
  const end = heading < 0 ? -1 : log.indexOf('\n\ntest/', heading + 1);
  const block = heading < 0 ? '' : log.slice(heading, end < 0 ? undefined : end);
  const green = block.includes('(pass)') && !block.includes('(fail)') && !block.includes('# Unhandled error');
  const exit = entry.result === 'green' && Number.isFinite(independent[entry.path]) && independent[entry.path]! <= 30000;
  const result = (!Number.isFinite(ms) ? 'NOT MEASURED' : green ? 'GREEN' : 'RED / not confirmed green (see log)') + (exit ? ' — exit: green single-file ≤ 30 s; remove entry' : '');
  lines.push(`| ${entry.path} | ${Number.isFinite(ms) ? (ms! / 1000).toFixed(3) : 'missing'} | ${entry.seconds} | ${result} |`);
}
lines.push(`| **Total** | **${(total / 1000).toFixed(3)}** | **${listedTotal.toFixed(3)}** | ${process.env.SLOW_OUTCOME ?? 'unknown'} |`, '', `Log: ${resolve(logPath)}. Exit candidates require a green single-file confirmation; this batch run is repair feedback.`);
appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
