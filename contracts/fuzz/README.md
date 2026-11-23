# Contract Fuzzing & Corpus Management

This crate (`accord-fuzz`) contains `libFuzzer` / `cargo-fuzz` targets that exercise core invariants of the Accord Soroban smart contract (`contracts/accord`):

| Fuzz Target | Source | Invariants Covered |
| --- | --- | --- |
| `weight_arithmetic` | `fuzz_targets/weight_arithmetic.rs` | Sum of per-owner weights always equals `get_total_weight()`; proposal approval weights never exceed creation-time total weight or drift from recorded votes across add/remove/weight-change/threshold proposals. |
| `proposal_bookkeeping` | `fuzz_targets/proposal_bookkeeping.rs` | Monotonic proposal IDs without gaps or reuse; `ACTCNT` instance counter equals live (`Pending` + `Ready`) proposals and never exceeds the 50-proposal cap across creations, executions, and `cancel_expired`. |
| `proposal_input_validation` | `fuzz_targets/proposal_input_validation.rs` | Description length bounds (`1..=300`), deadline duration bounds (`NOW + 1..=NOW + 7_776_000`), and rejection of malformed `ProposalCategory` XDR values without host panics. |

## Persisted Corpus Structure

Committed seeds and regression fixtures live under `contracts/fuzz/corpus/`:

```text
contracts/fuzz/corpus/
├── manifest.json
├── weight_arithmetic/
│   ├── regression-total-weight-drift-guard
│   ├── seed-balanced-weights
│   └── seed-boundary-weights
├── proposal_bookkeeping/
│   ├── regression-active-count-expiry-reuse
│   ├── seed-boundary-active-cap
│   └── seed-lifecycle-mix
└── proposal_input_validation/
    ├── regression-malformed-category-and-overflow-deadline
    ├── seed-boundary-empty-and-max-deadline
    └── seed-valid-transfer-category
```

Every target directory must retain at least one `regression-*` fixture pinning a historical edge case, and all committed inputs are validated for size bounds, deduplication, and secret hygiene.

## Validating and Minimizing the Corpus

Run the deterministic corpus test suite and validator from the repository root:

```bash
node --test scripts/fuzz-corpus.test.mjs
node scripts/fuzz-corpus.mjs validate --report-dir target/fuzz-corpus
```

After a local or nightly fuzz campaign, deduplicate and minimize the corpus:

```bash
# Minimize via cargo-fuzz (requires nightly Rust + cargo-fuzz)
cargo +nightly fuzz cmin --fuzz-dir contracts/fuzz weight_arithmetic
cargo +nightly fuzz cmin --fuzz-dir contracts/fuzz proposal_bookkeeping
cargo +nightly fuzz cmin --fuzz-dir contracts/fuzz proposal_input_validation

# Enforce manifest bounds, deduplicate digests, and preserve regression-* fixtures
node scripts/fuzz-corpus.mjs minimize --report-dir target/fuzz-corpus
```

## Nightly Extended Fuzzing

`.github/workflows/nightly.yml` (`contract_fuzz` job) restores the cached corpus, runs extended fuzzing across all three targets, minimizes newly discovered inputs, and uploads both the minimized corpus (`nightly-contract-fuzz-corpus`) and sanitized diagnostic reports (`nightly-contract-fuzz-report`).
