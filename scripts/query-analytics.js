#!/usr/bin/env node

/**
 * query-analytics.js — CLI example tool for querying indexed analytics data.
 *
 * Demonstrates how to read indexed events/proposals, aggregate treasury metrics,
 * and format readable terminal output (spend by category, treasury flow, summary).
 *
 * Usage:
 *   node scripts/query-analytics.js <command> [options]
 *
 * Commands:
 *   spend-by-category   Display aggregated spending categorized by proposal label
 *   treasury-flow       Display treasury inflows and outflows over time
 *   summary             Display overall treasury metrics (total spend, volume, counts)
 *
 * Options:
 *   --file=<path>       Path to JSON file containing indexed proposal data
 *   --granularity=<g>   Time aggregation window for treasury-flow: day | week | month (default: day)
 *   --help, -h          Show this help message
 */

import fs from 'node:fs';
import path from 'node:path';

const VALID_COMMANDS = ['spend-by-category', 'treasury-flow', 'summary'];
const VALID_GRANULARITIES = ['day', 'week', 'month'];

function printUsage() {
  console.log(`
Usage: node scripts/query-analytics.js <command> [options]

Commands:
  spend-by-category   Aggregate executed payments by category with amounts and shares
  treasury-flow       Aggregate executed disbursements over time (inflow / outflow)
  summary             High-level treasury metrics (total volume, executed transactions)

Options:
  --file=<path>       Path to JSON store file (default: checks ANALYTICS_DATA_FILE or sample)
  --granularity=<g>   Grouping interval for treasury-flow (day | week | month, default: day)
  --help, -h          Display this help message

Examples:
  node scripts/query-analytics.js spend-by-category
  node scripts/query-analytics.js treasury-flow --granularity=week
  node scripts/query-analytics.js summary --file=./data/sample-indexed-events.json
`);
}

function parseArgs(args) {
  let command = null;
  const options = {
    file: process.env.ANALYTICS_DATA_FILE || process.env.STORE_PATH || process.env.INDEXER_STORE_PATH || null,
    granularity: 'day',
    help: false,
  };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--file=')) {
      options.file = arg.split('=')[1];
    } else if (arg.startsWith('--granularity=')) {
      options.granularity = arg.split('=')[1];
    } else if (!arg.startsWith('-') && !command) {
      command = arg;
    } else {
      console.error(`Error: Unrecognized option or argument "${arg}"\n`);
      printUsage();
      process.exit(1);
    }
  }

  return { command, options };
}

function loadData(filePath) {
  if (!filePath) {
    const samplePath = path.resolve(process.cwd(), 'scripts/sample-analytics-data.json');
    if (fs.existsSync(samplePath)) {
      filePath = samplePath;
    } else {
      return [];
    }
  }

  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: Specified data file not found at: ${resolved}`);
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(resolved, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.proposals)) return parsed.proposals;
    if (parsed && Array.isArray(parsed.events)) return parsed.events;
    return [];
  } catch (err) {
    console.error(`Error: Failed to parse JSON file at ${resolved}: ${err.message}`);
    process.exit(1);
  }
}

function normalizeProposals(records) {
  return records
    .filter((r) => r && (r.status === 'executed' || r.status?.Executed !== undefined || r.executed))
    .map((r) => ({
      id: r.id,
      amount: parseFloat(r.amount || 0),
      category: r.category || 'Other',
      proposer: r.proposer || 'Unknown',
      timestamp: r.timestamp || r.executedAt || r.createdAt || new Date().toISOString(),
      token: r.token || 'XLM',
    }));
}

function runSpendByCategory(records) {
  const executed = normalizeProposals(records);
  if (executed.length === 0) {
    console.log('No executed spending records found in the analytics store.');
    return;
  }

  const totals = {};
  let overall = 0;

  for (const item of executed) {
    const cat = item.category || 'Other';
    totals[cat] = (totals[cat] || 0) + item.amount;
    overall += item.amount;
  }

  const rows = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .map(([category, total]) => ({
      Category: category,
      'Total Amount': total.toFixed(2),
      'Share (%)': overall > 0 ? `${((total / overall) * 100).toFixed(1)}%` : '0.0%',
    }));

  console.log('\n--- Accord Protocol: Spend by Category ---');
  console.table(rows);
  console.log(`Total Spend: ${overall.toFixed(2)} across ${executed.length} executed transaction(s).\n`);
}

function runTreasuryFlow(records, granularity) {
  const executed = normalizeProposals(records);
  if (executed.length === 0) {
    console.log('No treasury flow data available in the analytics store.');
    return;
  }

  const buckets = {};

  for (const item of executed) {
    const d = new Date(item.timestamp);
    const dateStr = isNaN(d.getTime()) ? 'Unknown' : d.toISOString().split('T')[0];
    let key = dateStr;

    if (granularity === 'month' && dateStr !== 'Unknown') {
      key = dateStr.slice(0, 7); // YYYY-MM
    }

    if (!buckets[key]) {
      buckets[key] = { outflow: 0, count: 0 };
    }
    buckets[key].outflow += item.amount;
    buckets[key].count += 1;
  }

  const rows = Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, data]) => ({
      Period: period,
      'Outflow Amount': data.outflow.toFixed(2),
      'Transactions': data.count,
    }));

  console.log(`\n--- Accord Protocol: Treasury Flow (${granularity}) ---`);
  console.table(rows);
  console.log('');
}

function runSummary(records) {
  const executed = normalizeProposals(records);
  if (executed.length === 0) {
    console.log('No analytics data available to summarize. Store is empty.');
    return;
  }

  const totalOutflow = executed.reduce((acc, curr) => acc + curr.amount, 0);
  const categories = new Set(executed.map((e) => e.category)).size;

  console.log('\n========================================');
  console.log('     ACCORD TREASURY ANALYTICS SUMMARY   ');
  console.log('========================================');
  console.log(`  Total Executed Spend : ${totalOutflow.toFixed(2)}`);
  console.log(`  Total Transactions   : ${executed.length}`);
  console.log(`  Active Categories    : ${categories}`);
  console.log('========================================\n');
}

function main() {
  const args = process.argv.slice(2);
  const { command, options } = parseArgs(args);

  if (options.help || !command) {
    printUsage();
    process.exit(options.help ? 0 : 1);
  }

  if (!VALID_COMMANDS.includes(command)) {
    console.error(`Error: Unknown command "${command}".`);
    console.error(`Available commands: ${VALID_COMMANDS.join(', ')}\n`);
    printUsage();
    process.exit(1);
  }

  if (!VALID_GRANULARITIES.includes(options.granularity)) {
    console.error(`Error: Invalid granularity "${options.granularity}". Must be one of: ${VALID_GRANULARITIES.join(', ')}\n`);
    process.exit(1);
  }

  const records = loadData(options.file);

  switch (command) {
    case 'spend-by-category':
      runSpendByCategory(records);
      break;
    case 'treasury-flow':
      runTreasuryFlow(records, options.granularity);
      break;
    case 'summary':
      runSummary(records);
      break;
  }
}

main();
