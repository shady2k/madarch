#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readSlowList, SLOW_EXIT_SECONDS, testFiles } from './run-tests.js';

const [timingsPath, logPath] = process.argv.slice(2);
if (!timingsPath || !logPath || !process.env.GITHUB_STEP_SUMMARY) {
  console.error(`${import.meta.path}:1: expected timings, log and GITHUB_STEP_SUMMARY`);
  process.exit(2);
}
const all = testFiles(process.cwd());
const slow = readSlowList(process.cwd(), all);
const files: Record<string, number> = existsSync(timingsPath) ? JSON.parse(readFileSync(timingsPath, 'utf8')).files : {};
const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
type Observation = 'GREEN' | 'RED' | 'UNCONFIRMED';
const observations = new Map<string, Observation>();
const headings = new Map(all.map(path => [`${path}:`, path]));
let current: string | undefined;
for (const line of log.split('\n')) {
  const trimmed = line.trim();
  const heading = headings.get(trimmed.startsWith('./') ? trimmed.slice(2) : trimmed);
  if (heading !== undefined) {
    current = heading;
  } else if (current !== undefined) {
    if (line.includes('(fail)') || line.includes('# Unhandled error')) observations.set(current, 'RED');
    else if (line.includes('(pass)') && observations.get(current) !== 'RED') observations.set(current, 'GREEN');
  }
}
const lines = [`## Slow tests: ${process.env.SLOW_OUTCOME ?? 'unknown'}`, '', '| Path | Measured seconds | Listed seconds | Result | Claim |', '|---|---:|---:|---|---|'];
let total = 0;
let listedTotal = 0;
let contradiction = false;
for (const entry of slow.files) {
  const ms = files[entry.path];
  listedTotal += entry.seconds;
  if (Number.isFinite(ms)) total += ms!;
  const observed = observations.get(entry.path) ?? 'UNCONFIRMED';
  const mismatch = (entry.result === 'red' && observed === 'GREEN') || (entry.result === 'green' && observed === 'RED');
  if (mismatch) contradiction = true;
  const candidate = observed === 'GREEN' && Number.isFinite(ms) && ms! <= SLOW_EXIT_SECONDS * 1000;
  const claim = mismatch ? `claimed ${entry.result}, ran ${observed.toLowerCase()}`
    : observed === 'UNCONFIRMED' ? 'unconfirmed: no observed result'
    : 'claimed, measurement matches';
  const result = observed + (candidate ? ' — exit candidate' : '');
  lines.push(`| ${entry.path} | ${Number.isFinite(ms) ? (ms! / 1000).toFixed(3) : 'missing'} | ${entry.seconds} | ${result} | ${claim} |`);
}
lines.push(`| **Total** | **${(total / 1000).toFixed(3)}** | **${listedTotal.toFixed(3)}** | ${process.env.SLOW_OUTCOME ?? 'unknown'} | |`, '', `Log: ${resolve(logPath)}. Exit candidates require a green single-file confirmation; this batch run is repair feedback.`);
appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
if (contradiction) process.exit(1);
