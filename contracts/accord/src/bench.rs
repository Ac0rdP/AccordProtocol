//! Resource and CPU regression gate (#814).
//!
//! Measures the metered cost of the hot entrypoints and compares it with the
//! committed baseline in `bench-baseline.txt`. A metric that grows by more than
//! the threshold fails the build; every run writes a delta report that CI
//! publishes on pull requests.
//!
//! ```text
//! cargo test -p accord --lib bench_hot_entrypoints -- --nocapture   # compare
//! ACCORD_BENCH_UPDATE=1 cargo test -p accord --lib bench_hot_entrypoints  # re-record baseline
//! ```
//!
//! `ACCORD_BENCH_THRESHOLD_PCT` overrides the default threshold (5%). Reports
//! land in `target/bench/report.md` and `target/bench/report.json`. See
//! CONTRIBUTING.md ("Benchmark regression gate") for the update policy.
//!
//! Costs come from the Soroban test host's deterministic metering
//! (`env.cost_estimate().resources()`), so identical code gives identical
//! numbers and a small threshold is safe. Native execution under-reports Wasm
//! CPU, but a change in the figure still tracks a change in real cost.

extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Env, String, Vec};
use std::collections::BTreeMap;
use std::format;
use std::string::{String as StdString, ToString};
use std::vec::Vec as StdVec;

const BASELINE_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/bench-baseline.txt");
const BASELINE: &str = include_str!("../bench-baseline.txt");
const DEFAULT_THRESHOLD_PCT: f64 = 5.0;

const NOW: u64 = 1_000;
const DEADLINE: u64 = NOW + 86_400;

/// The metered figures tracked per entrypoint.
const METRICS: [&str; 5] = [
    "instructions",
    "mem_bytes",
    "ledger_entries",
    "write_entries",
    "write_bytes",
];

type Sample = BTreeMap<&'static str, i64>;

fn sample(env: &Env) -> Sample {
    let r = env.cost_estimate().resources();
    let mut s = Sample::new();
    s.insert("instructions", r.instructions);
    s.insert("mem_bytes", r.mem_bytes);
    s.insert(
        "ledger_entries",
        (r.disk_read_entries + r.memory_read_entries + r.write_entries) as i64,
    );
    s.insert("write_entries", r.write_entries as i64);
    s.insert("write_bytes", r.write_bytes as i64);
    s
}

/// Runs every hot entrypoint once on a fresh 3-owner, threshold-2 treasury.
fn measure() -> StdVec<(&'static str, Sample)> {
    let env = Env::default();
    env.mock_all_auths();
    let mut ledger = env.ledger().get();
    ledger.timestamp = NOW;
    env.ledger().set(ledger);

    let owner_a = Address::generate(&env);
    let owner_b = Address::generate(&env);
    let owner_c = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token_sac = token::StellarAssetClient::new(&env, &token_id.address());

    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);
    token_sac.mint(&contract_id, &1_000_000_000_000_i128);

    let owners = Vec::from_array(&env, [owner_a.clone(), owner_b.clone(), owner_c.clone()]);
    let weights = Vec::from_array(&env, [1u32, 1, 1]);
    let desc = String::from_str(&env, "bench");

    let mut out = StdVec::new();
    macro_rules! record {
        ($name:expr) => {
            out.push(($name, sample(&env)));
        };
    }

    client.initialize(&owners, &weights, &2, &0);
    record!("initialize");

    let transfers = Vec::from_array(
        &env,
        [Transfer {
            to: recipient.clone(),
            token: token_id.address(),
            amount: 10,
        }],
    );
    let id = client.create_proposal(&owner_a, &transfers, &desc, &DEADLINE, &ProposalCategory::Transfer);
    record!("create_proposal");

    client.approve(&owner_a, &id);
    record!("approve");

    client.revoke(&owner_a, &id);
    record!("revoke");

    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    record!("approve_reaching_threshold");

    client.execute(&owner_c, &id);
    record!("execute_transfer");

    let gov = client.create_change_threshold_proposal(&owner_a, &1, &desc, &DEADLINE);
    record!("create_change_threshold_proposal");
    client.approve(&owner_a, &gov);
    client.approve(&owner_b, &gov);
    client.execute(&owner_c, &gov);
    record!("execute_change_threshold");

    client.get_proposal(&id);
    record!("get_proposal");

    client.get_owner_weights();
    record!("get_owner_weights");

    out
}

fn parse_baseline(text: &str) -> BTreeMap<StdString, BTreeMap<StdString, i64>> {
    let mut baseline = BTreeMap::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let mut parts = line.split_whitespace();
        let name = parts.next().expect("baseline line has a name").to_string();
        let mut metrics = BTreeMap::new();
        for pair in parts {
            let (key, value) = pair.split_once('=').expect("baseline metrics are key=value");
            metrics.insert(key.to_string(), value.parse::<i64>().expect("baseline value is an integer"));
        }
        baseline.insert(name, metrics);
    }
    baseline
}

fn render_baseline(results: &[(&'static str, Sample)]) -> StdString {
    let mut text = StdString::from(
        "# Recorded resource baseline for the hot entrypoints (see src/bench.rs and CONTRIBUTING.md).\n\
         # Regenerate deliberately: ACCORD_BENCH_UPDATE=1 cargo test -p accord --lib bench_hot_entrypoints\n",
    );
    for (name, s) in results {
        text.push_str(name);
        for metric in METRICS {
            text.push_str(&format!(" {}={}", metric, s[metric]));
        }
        text.push('\n');
    }
    text
}

fn pct_delta(current: i64, base: i64) -> f64 {
    if base == 0 {
        if current == 0 { 0.0 } else { f64::INFINITY }
    } else {
        (current - base) as f64 * 100.0 / base as f64
    }
}

#[test]
fn bench_hot_entrypoints() {
    let threshold: f64 = std::env::var("ACCORD_BENCH_THRESHOLD_PCT")
        .ok()
        .map(|v| v.parse().expect("ACCORD_BENCH_THRESHOLD_PCT must be a number"))
        .unwrap_or(DEFAULT_THRESHOLD_PCT);
    let update = std::env::var("ACCORD_BENCH_UPDATE").map(|v| v == "1").unwrap_or(false);

    let results = measure();
    // Metering is deterministic: a second pass must reproduce the first, or a
    // threshold would flake.
    let again = measure();
    assert_eq!(
        results.iter().map(|(_, s)| s.clone()).collect::<StdVec<_>>(),
        again.iter().map(|(_, s)| s.clone()).collect::<StdVec<_>>(),
        "benchmark metering is not deterministic"
    );

    if update {
        std::fs::write(BASELINE_PATH, render_baseline(&results)).expect("write bench-baseline.txt");
        std::println!("[bench] baseline rewritten at {}", BASELINE_PATH);
        return;
    }

    let baseline = parse_baseline(BASELINE);
    let mut md = StdString::from(format!(
        "### Contract resource benchmarks\n\nThreshold: +{threshold}% per metric. Baseline: `contracts/accord/bench-baseline.txt`.\n\n\
         | Entrypoint | Metric | Baseline | Current | Delta | Status |\n| --- | --- | ---: | ---: | ---: | --- |\n"
    ));
    let mut json = StdVec::new();
    let mut regressions = StdVec::new();
    let mut missing = StdVec::new();

    for (name, current) in &results {
        let Some(base) = baseline.get(*name) else {
            missing.push(name.to_string());
            continue;
        };
        for metric in METRICS {
            let cur = current[metric];
            let Some(&b) = base.get(metric) else {
                missing.push(format!("{name}.{metric}"));
                continue;
            };
            let delta = pct_delta(cur, b);
            let status = if delta > threshold {
                regressions.push(format!("{name}.{metric}: {b} -> {cur} ({delta:+.2}%)"));
                "REGRESSION"
            } else if delta < -threshold {
                "improved"
            } else {
                "ok"
            };
            md.push_str(&format!("| {name} | {metric} | {b} | {cur} | {delta:+.2}% | {status} |\n"));
            json.push(format!(
                "{{\"entrypoint\":\"{name}\",\"metric\":\"{metric}\",\"baseline\":{b},\"current\":{cur},\"delta_pct\":{delta:.4},\"status\":\"{status}\"}}"
            ));
        }
    }

    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/bench");
    std::fs::create_dir_all(dir).expect("create target/bench");
    std::fs::write(format!("{dir}/report.md"), &md).expect("write report.md");
    std::fs::write(
        format!("{dir}/report.json"),
        format!("{{\"threshold_pct\":{threshold},\"results\":[{}]}}\n", json.join(",")),
    )
    .expect("write report.json");
    std::println!("{md}");

    assert!(
        missing.is_empty(),
        "no baseline for: {}. Record one with ACCORD_BENCH_UPDATE=1 (see CONTRIBUTING.md)",
        missing.join(", ")
    );
    assert!(
        regressions.is_empty(),
        "resource regression beyond +{threshold}%:\n  {}\nIf the growth is intended, update the baseline per CONTRIBUTING.md.",
        regressions.join("\n  ")
    );
}

#[test]
fn bench_baseline_helpers_roundtrip() {
    let mut s = Sample::new();
    for (i, metric) in METRICS.iter().enumerate() {
        s.insert(*metric, 100 * (i as i64 + 1));
    }
    let parsed = parse_baseline(&render_baseline(&[("demo", s)]));
    assert_eq!(parsed["demo"]["instructions"], 100);
    assert_eq!(parsed["demo"]["write_bytes"], 500);
    assert!(pct_delta(106, 100) > DEFAULT_THRESHOLD_PCT);
    assert!(pct_delta(104, 100) < DEFAULT_THRESHOLD_PCT);
    assert_eq!(pct_delta(0, 0), 0.0);
    assert!(pct_delta(1, 0).is_infinite());
}
