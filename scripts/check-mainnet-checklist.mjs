#!/usr/bin/env node
// Mainnet launch gate. See docs/MAINNET_LAUNCH.md.
//
//   node scripts/check-mainnet-checklist.mjs --release v1.0.0   # strict: every item done and signed off
//   node scripts/check-mainnet-checklist.mjs --structure        # schema only (PRs, pre-release tags)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATEGORIES = new Set(['code', 'tests', 'operations']);
const args = process.argv.slice(2);
const structureOnly = args.includes('--structure');
const release = args.includes('--release') ? args[args.indexOf('--release') + 1] : undefined;

const checklist = JSON.parse(readFileSync(join(ROOT, 'launch/mainnet-checklist.json'), 'utf8'));
const problems = [];

function evidenceResolves(ref) {
  if (/^https:\/\/\S+$/.test(ref)) return true;
  const path = normalize(ref.split('#')[0]);
  return !path.startsWith('..') && existsSync(join(ROOT, path));
}

if (!structureOnly) {
  if (!release) problems.push('pass --release <tag> (or --structure)');
  else if (checklist.release !== release) {
    problems.push(`checklist is for release "${checklist.release}", not "${release}"; review it for this launch and update "release"`);
  }
}

const seen = new Set();
for (const item of checklist.items ?? []) {
  const id = item.id ?? '(no id)';
  if (seen.has(id)) problems.push(`${id}: duplicate id`);
  seen.add(id);
  if (!CATEGORIES.has(item.category)) problems.push(`${id}: category must be code, tests or operations`);
  if (!item.requirement) problems.push(`${id}: missing requirement`);
  if (!item.evidence) problems.push(`${id}: missing evidence`);
  if (!['pending', 'done'].includes(item.status)) problems.push(`${id}: status must be pending or done`);
  if (structureOnly) continue;

  if (item.status !== 'done') problems.push(`${id}: not done — ${item.requirement}`);
  else {
    if (item.evidence && !evidenceResolves(item.evidence)) problems.push(`${id}: evidence "${item.evidence}" does not resolve`);
    const { by, date } = item.signOff ?? {};
    if (!by || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || Date.parse(date) > Date.now()) {
      problems.push(`${id}: needs signOff { by, date: YYYY-MM-DD }`);
    }
  }
}
for (const category of CATEGORIES) {
  if (!(checklist.items ?? []).some((i) => i.category === category)) problems.push(`no ${category} items`);
}

if (problems.length > 0) {
  console.error(`Mainnet launch checklist: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(structureOnly ? 'Mainnet checklist structure OK.' : `Mainnet checklist complete for ${release}.`);
