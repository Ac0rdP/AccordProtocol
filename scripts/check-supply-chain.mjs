#!/usr/bin/env node
// Enforces docs/SUPPLY_CHAIN_POLICY.md. Dependency-free so it can run before any install step.
//
//   node scripts/check-supply-chain.mjs
//
// Every violation must either be fixed or covered by a live entry in
// supply-chain/exceptions.json. Exits non-zero when any violation is uncovered,
// when an exception is malformed or expired, or when an exception no longer
// matches anything (stale exceptions are removed, not carried).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXCEPTIONS_FILE = 'supply-chain/exceptions.json';
const MAX_EXCEPTION_DAYS = 180;
const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const FIRST_PARTY_ACTION_OWNERS = new Set(['actions', 'github']);
const RULES = new Set([
  'lockfile-missing',
  'lockfile-integrity',
  'manifest-spec',
  'cargo-source',
  'action-unpinned',
  'npm-install',
  'cargo-unlocked',
]);

const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const tracked = () =>
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);

/** A violation is identified by `${rule}:${target}`, which is what an exception names. */
const violation = (rule, target, detail) => ({ rule, target, detail });

export function checkCargoLock(text) {
  const out = [];
  for (const block of text.split(/\n\[\[package\]\]\n/).slice(1)) {
    const name = /^name = "(.+)"$/m.exec(block)?.[1] ?? '?';
    const version = /^version = "(.+)"$/m.exec(block)?.[1] ?? '?';
    const source = /^source = "(.+)"$/m.exec(block)?.[1];
    if (source === undefined) continue; // workspace member
    if (source !== CRATES_IO) {
      out.push(violation('cargo-source', `${name}@${version}`, `source ${source} is not crates.io`));
    } else if (!/^checksum = "[0-9a-f]{64}"$/m.test(block)) {
      out.push(violation('cargo-source', `${name}@${version}`, 'registry crate has no checksum'));
    }
  }
  return out;
}

export function checkNpmLock(dir, lock) {
  const out = [];
  const packages = lock.packages ?? {};
  if (!lock.lockfileVersion || lock.lockfileVersion < 2) {
    out.push(violation('lockfile-integrity', `${dir}/package-lock.json`, 'lockfileVersion must be 2 or 3'));
  }
  for (const [path, meta] of Object.entries(packages)) {
    // Bundled packages ship inside their (integrity-checked) parent tarball.
    if (path === '' || meta.link || meta.inBundle) continue;
    const label = `${dir}:${path.replace(/^.*node_modules\//, '')}@${meta.version ?? '?'}`;
    if (!meta.resolved || !meta.resolved.startsWith(NPM_REGISTRY)) {
      out.push(violation('lockfile-integrity', label, `resolved from ${meta.resolved ?? 'nowhere'}, not ${NPM_REGISTRY}`));
    } else if (!/^sha512-/.test(meta.integrity ?? '')) {
      out.push(violation('lockfile-integrity', label, 'missing sha512 integrity hash'));
    }
  }
  return out;
}

export function checkManifest(dir, manifest) {
  const out = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      const loose = spec === '*' || spec === '' || spec === 'latest' || spec === 'x';
      const remote = /^(git|github:|https?:|[\w.-]+\/[\w.-]+(#|$))/.test(spec) || spec.includes('://');
      if (loose || remote) {
        out.push(violation('manifest-spec', `${dir}:${name}`, `"${spec}" is not a registry version range`));
      }
    }
  }
  return out;
}

export function checkWorkflow(file, text) {
  const out = [];
  // Join shell line continuations so a flag on a later line still counts.
  const lines = text.replace(/\\\n\s*/g, ' ').split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#') || /^-?\s*name:/.test(line)) continue;

    const uses = /^-?\s*uses:\s*(\S+)/.exec(line)?.[1];
    if (uses && !uses.startsWith('./') && !uses.startsWith('docker://')) {
      const [spec, ref = ''] = uses.split('@');
      const owner = spec.split('/')[0];
      const pinned = /^[0-9a-f]{40}$/.test(ref);
      if (!pinned && !FIRST_PARTY_ACTION_OWNERS.has(owner)) {
        out.push(violation('action-unpinned', uses, `${file}: third-party action must be pinned to a full commit SHA`));
      }
    }

    if (/\bnpm\s+(install|i)\b(?!\s+(-g|--global))/.test(line)) {
      out.push(violation('npm-install', file, `${file}: use \`npm ci\` so the lockfile is enforced`));
    }
    const cargo = /\bcargo\s+(build|test|check|clippy|run|doc|bench|install|llvm-cov(?!\s+report))\b/.exec(line);
    if (cargo && !/\s--locked\b/.test(line)) {
      out.push(violation('cargo-unlocked', `${file}:cargo ${cargo[1]}`, `${file}: \`cargo ${cargo[1]}\` must pass --locked`));
    }
  }
  return out;
}

export function validateExceptions(doc, today = new Date()) {
  const errors = [];
  const list = doc?.exceptions;
  if (!Array.isArray(list)) return ['exceptions.json must contain an "exceptions" array'];
  const seen = new Set();
  for (const e of list) {
    const id = e?.id ?? '(no id)';
    for (const f of ['id', 'rule', 'target', 'reason', 'requestedBy', 'added', 'expires']) {
      if (typeof e?.[f] !== 'string' || e[f].trim() === '') errors.push(`${id}: missing "${f}"`);
    }
    if (seen.has(e?.id)) errors.push(`${id}: duplicate id`);
    seen.add(e?.id);
    if (e?.rule && !RULES.has(e.rule)) errors.push(`${id}: unknown rule "${e.rule}"`);
    const added = Date.parse(e?.added);
    const expires = Date.parse(e?.expires);
    if (Number.isNaN(added) || Number.isNaN(expires)) {
      errors.push(`${id}: "added" and "expires" must be ISO dates`);
      continue;
    }
    if (expires < today.getTime()) errors.push(`${id}: expired on ${e.expires}; fix the finding or renew through review`);
    if ((expires - added) / 86_400_000 > MAX_EXCEPTION_DAYS) {
      errors.push(`${id}: lifetime exceeds ${MAX_EXCEPTION_DAYS} days`);
    }
  }
  return errors;
}

function collect() {
  const files = tracked();
  const found = [];

  if (!existsSync(join(ROOT, 'Cargo.lock'))) found.push(violation('lockfile-missing', 'Cargo.lock', 'Cargo.lock is not committed'));
  else found.push(...checkCargoLock(read('Cargo.lock')));

  const manifests = files.filter((f) => /(^|\/)package\.json$/.test(f) && !f.includes('node_modules/'));
  for (const manifest of manifests) {
    const dir = dirname(manifest);
    found.push(...checkManifest(dir, JSON.parse(read(manifest))));
    const lockPath = join(dir, 'package-lock.json');
    if (!files.includes(lockPath)) {
      found.push(violation('lockfile-missing', dir, `${dir} has no committed package-lock.json`));
    } else {
      found.push(...checkNpmLock(dir, JSON.parse(read(lockPath))));
    }
  }

  const wfDir = join(ROOT, '.github/workflows');
  for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
    found.push(...checkWorkflow(`.github/workflows/${f}`, readFileSync(join(wfDir, f), 'utf8')));
  }
  return found;
}

export function main() {
  const doc = JSON.parse(read(EXCEPTIONS_FILE));
  const problems = validateExceptions(doc);

  const found = collect();
  const key = (v) => `${v.rule}:${v.target}`;
  const excepted = new Map(doc.exceptions.map((e) => [`${e.rule}:${e.target}`, e]));
  const used = new Set();

  for (const v of found) {
    if (excepted.has(key(v))) used.add(key(v));
    else problems.push(`${v.rule} ${v.target} — ${v.detail}`);
  }
  for (const k of excepted.keys()) {
    if (!used.has(k)) problems.push(`stale exception ${k} matches nothing; remove it from ${EXCEPTIONS_FILE}`);
  }

  if (problems.length > 0) {
    console.error(`Supply-chain policy violations (${problems.length}):`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nSee docs/SUPPLY_CHAIN_POLICY.md for the rules and the exception process.');
    process.exit(1);
  }
  console.log(`Supply-chain policy OK (${found.length} findings, ${used.size} reviewed exceptions).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
