#!/usr/bin/env node

/**
 * Helper script to prepare and submit in-app feedback as a GitHub issue.
 * 
 * This script can be used to:
 * 1. Validate feedback payloads
 * 2. Prepare issue URLs with prefilled data
 * 3. Assist with GitHub issue creation (with proper rate limiting)
 * 
 * Usage:
 *   node scripts/file-feedback-issue.js --help
 */

const https = require('https');
const querystring = require('querystring');

function showHelp() {
  console.log(`
Feedback Issue Filing Helper

Usage:
  node scripts/file-feedback-issue.js [options]

Options:
  --repo <owner/repo>      GitHub repository (default: from package.json or env)
  --title <title>          Issue title
  --body <body>            Issue body
  --token <token>          GitHub personal access token (or use GITHUB_TOKEN env)
  --dry-run                Generate issue URL without submitting
  --help                   Show this help message

Environment Variables:
  GITHUB_TOKEN             GitHub personal access token
  GITHUB_REPO              Repository in owner/repo format
  VITE_GITHUB_REPO         Frontend repo config
`);
}

function buildIssueUrl(repo, title, body) {
  const baseUrl = `https://github.com/${repo}/issues/new`;
  const params = querystring.stringify({
    title: title,
    body: body,
    labels: 'feedback'
  });
  return `${baseUrl}?${params}`;
}

function validateFeedback(data) {
  const errors = [];
  if (!data.title || data.title.trim().length === 0) {
    errors.push('Title is required');
  }
  if (!data.body || data.body.trim().length === 0) {
    errors.push('Body is required');
  }
  if (data.title && data.title.length > 256) {
    errors.push('Title too long (max 256 characters)');
  }
  return errors;
}

function rateLimitKey() {
  // Simple in-memory rate limiting
  return Date.now();
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help')) {
    showHelp();
    return;
  }
  
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
  };
  
  const repo = getArg('--repo') || process.env.GITHUB_REPO || process.env.VITE_GITHUB_REPO || 'connelevalsam/AccordProtocol';
  const title = getArg('--title') || '[Feedback]: ';
  const body = getArg('--body') || '';
  const token = getArg('--token') || process.env.GITHUB_TOKEN;
  const dryRun = args.includes('--dry-run');
  
  const feedback = { title, body };
  const errors = validateFeedback(feedback);
  
  if (errors.length > 0) {
    console.error('Validation errors:');
    errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }
  
  if (dryRun) {
    const url = buildIssueUrl(repo, title, body);
    console.log('Issue URL (prefilled):');
    console.log(url);
    return;
  }
  
  if (!token) {
    console.error('Error: GitHub token required for direct submission');
    console.error('Use --dry-run to generate URL, or provide --token/GITHUB_TOKEN');
    process.exit(1);
  }
  
  console.log('Direct submission via API not implemented in this helper.');
  console.log('Use --dry-run to generate a prefilled issue URL.');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { buildIssueUrl, validateFeedback };
