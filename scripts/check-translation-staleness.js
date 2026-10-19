#!/usr/bin/env node

/**
 * check-translation-staleness.js
 *
 * Verifies localized documentation files under docs/i18n/ against the git
 * history of their source English documents.
 *
 * Checks:
 *   1. Translated file carries valid YAML front matter.
 *   2. The referenced `source_file` exists in the repository.
 *   3. Compares `source_commit` with git history: if the source file was modified
 *      after `source_commit`, flags the translation as STALE.
 *
 * Usage:
 *   node scripts/check-translation-staleness.js
 *   node scripts/check-translation-staleness.js --strict  # exit 1 on stale/errors
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const I18N_DIR = path.join(REPO_ROOT, 'docs', 'i18n');

function parseFrontMatter(content) {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
  if (!match) return null;
  const raw = match[1];
  const data = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const val = trimmed.slice(colonIdx + 1).trim();
    data[key] = val;
  }
  return data;
}

function getLatestSourceCommit(sourceRelPath) {
  try {
    const stdout = execSync(
      `git log -n 1 --format="%H" -- "${sourceRelPath}"`,
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

function getCommitsBetween(fromCommit, sourceRelPath) {
  try {
    const stdout = execSync(
      `git rev-list ${fromCommit}..HEAD -- "${sourceRelPath}"`,
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    return stdout.trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return null;
  }
}

function findTranslatedFiles(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findTranslatedFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // Ignore root docs/i18n/README.md
      if (path.relative(I18N_DIR, fullPath) === 'README.md') continue;
      results.push(fullPath);
    }
  }
  return results;
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');

  console.log('Checking documentation translation staleness...');
  console.log(`Directory: ${path.relative(REPO_ROOT, I18N_DIR)}\n`);

  const files = findTranslatedFiles(I18N_DIR);
  if (files.length === 0) {
    console.log('No translated documents found under docs/i18n/.');
    process.exit(0);
  }

  let staleCount = 0;
  let errorCount = 0;
  let okCount = 0;

  for (const file of files) {
    const relFile = path.relative(REPO_ROOT, file);
    const content = fs.readFileSync(file, 'utf8');
    const fm = parseFrontMatter(content);

    if (!fm) {
      console.log(`❌ ${relFile}`);
      console.log('   Error: Missing YAML front matter block (--- ... ---)\n');
      errorCount++;
      continue;
    }

    const { source_file, source_commit, locale, status } = fm;
    if (!source_file || !source_commit) {
      console.log(`❌ ${relFile}`);
      console.log('   Error: Front matter missing required "source_file" or "source_commit"\n');
      errorCount++;
      continue;
    }

    const absSourceFile = path.join(REPO_ROOT, source_file);
    if (!fs.existsSync(absSourceFile)) {
      console.log(`❌ ${relFile}`);
      console.log(`   Error: Referenced source file "${source_file}" does not exist\n`);
      errorCount++;
      continue;
    }

    const latestCommit = getLatestSourceCommit(source_file);
    if (!latestCommit) {
      console.log(`⚠️  ${relFile}`);
      console.log(`   Warning: Could not determine git history for "${source_file}"\n`);
      continue;
    }

    if (source_commit === latestCommit) {
      console.log(`✅ ${relFile}`);
      console.log(`   Locale: ${locale || 'unspecified'} | Status: ${status || 'draft'}`);
      console.log(`   Source: ${source_file} (current at ${source_commit.slice(0, 8)})\n`);
      okCount++;
    } else {
      const commits = getCommitsBetween(source_commit, source_file);
      if (commits && commits.length > 0) {
        console.log(`⚠️  ${relFile} [STALE]`);
        console.log(`   Locale: ${locale || 'unspecified'} | Status: ${status || 'draft'}`);
        console.log(`   Source: ${source_file}`);
        console.log(`   Translated at commit: ${source_commit.slice(0, 8)}`);
        console.log(`   Latest commit:        ${latestCommit.slice(0, 8)} (${commits.length} commit(s) behind)\n`);
        staleCount++;
      } else {
        console.log(`✅ ${relFile}`);
        console.log(`   Locale: ${locale || 'unspecified'} | Status: ${status || 'draft'}`);
        console.log(`   Source: ${source_file} (up to date with ${latestCommit.slice(0, 8)})\n`);
        okCount++;
      }
    }
  }

  console.log('─'.repeat(50));
  console.log(`Summary: ${okCount} up to date, ${staleCount} stale, ${errorCount} errors`);

  if (strict && (staleCount > 0 || errorCount > 0)) {
    process.exit(1);
  }
}

main();
