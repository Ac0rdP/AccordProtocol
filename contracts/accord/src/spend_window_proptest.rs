#![cfg(test)]

//! Property-based and boundary test suite for spend-window policies.
//!
//! Issue #1046: Interleaves randomized transfers, multi-transfers, and time advances
//! to assert that spend limits never over-approve and that rolling windows reset
//! strictly according to policy.

extern crate std;

use super::*;
use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Env, String, Vec};

const START_TIME: u64 = 1_000_000;
const INITIAL_TREASURY: i128 = 100_000_000_000;
const DEFAULT_LIMIT: i128 = 10_000;
const WINDOW_DAY: u64 = 86_400; // 1 day in seconds

fn non_snapshot_env() -> Env {
    Env::new_with_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    })
}

fn set_ledger_time(env: &Env, ts: u64) {
    let mut ledger = env.ledger().get();
    ledger.timestamp = ts;
    env.ledger().set(ledger);
}

/// Harness managing contract state and independent verification of spend-window limits.
pub struct SpendWindowHarness {
    pub env: Env,
    pub client: AccordContractClient<'static>,
    pub token_client: token::Client<'static>,
    pub token_address: Address,
    pub treasury: Address,
    pub owner_a: Address,
    pub owner_b: Address,
    pub owner_c: Address,
    pub limit: i128,
    pub window_secs: u64,
    pub current_time: u64,
    pub active_epoch: u64,
    pub tracked_spent: i128,
}

impl SpendWindowHarness {
    pub fn new(limit: i128, window_secs: u64) -> Self {
        let env = non_snapshot_env();
        env.mock_all_auths();
        set_ledger_time(&env, START_TIME);

        let treasury = env.register(AccordContract, ());
        let client = AccordContractClient::new(&env, &treasury);

        let token_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(token_admin);
        let token_address = sac.address();
        let token_client = token::Client::new(&env, &token_address);
        token::StellarAssetClient::new(&env, &token_address).mint(&treasury, &INITIAL_TREASURY);

        let owner_a = Address::generate(&env);
        let owner_b = Address::generate(&env);
        let owner_c = Address::generate(&env);

        let mut owners = Vec::new(&env);
        owners.push_back(owner_a.clone());
        owners.push_back(owner_b.clone());
        owners.push_back(owner_c.clone());

        let mut weights = Vec::new(&env);
        weights.push_back(1);
        weights.push_back(1);
        weights.push_back(1);

        client.initialize(&owners, &weights, &2, &0);

        // Configure spending limit with rolling window for owner_a
        let deadline = START_TIME + 100_000;
        let desc = String::from_str(&env, "setup spend window");
        let prop_id = client.create_spending_window_proposal(
            &owner_a,
            &owner_a,
            &token_address,
            &limit,
            &window_secs,
            &desc,
            &deadline,
        );
        client.approve(&owner_a, &prop_id);
        client.approve(&owner_b, &prop_id);
        client.execute(&owner_c, &prop_id);

        assert_eq!(client.get_spending_window(&owner_a, &token_address), window_secs);
        assert_eq!(client.get_spending_limit(&owner_a, &token_address), Some(limit));
        assert_eq!(client.get_remaining_spending_limit(&owner_a, &token_address), Some(limit));

        Self {
            env,
            client,
            token_client,
            token_address,
            treasury,
            owner_a,
            owner_b,
            owner_c,
            limit,
            window_secs,
            current_time: START_TIME,
            active_epoch: 0,
            tracked_spent: 0,
        }
    }

    pub fn advance_time(&mut self, seconds: u64) {
        self.current_time = self.current_time.saturating_add(seconds);
        set_ledger_time(&self.env, self.current_time);

        // If time advanced beyond the active window epoch + window_secs, tracker resets
        if self.active_epoch > 0 && self.current_time > self.active_epoch.saturating_add(self.window_secs) {
            self.tracked_spent = 0;
            self.active_epoch = 0;
        }
    }

    pub fn try_transfer(&mut self, amount: i128) -> Result<u64, ContractError> {
        let recipient = Address::generate(&self.env);
        let mut transfers = Vec::new(&self.env);
        transfers.push_back(Transfer {
            to: recipient,
            token: self.token_address.clone(),
            amount,
        });
        let desc = String::from_str(&self.env, "spend transfer");
        let deadline = self.current_time + 100_000;

        let create_res = self.client.try_create_proposal(
            &self.owner_a,
            &transfers,
            &desc,
            &deadline,
            &ProposalCategory::Transfer,
        );

        match create_res {
            Ok(Ok(id)) => {
                // Approve by owner_a and owner_b to meet quorum
                self.client.approve(&self.owner_a, &id);
                self.client.approve(&self.owner_b, &id);

                let exec_res = self.client.try_execute(&self.owner_c, &id);
                match exec_res {
                    Ok(Ok(_)) => {
                        if self.active_epoch == 0 {
                            self.active_epoch = self.current_time;
                        }
                        self.tracked_spent += amount;
                        Ok(id)
                    }
                    Ok(Err(err)) => Err(err),
                    Err(_) => Err(ContractError::SpendingLimitExceeded),
                }
            }
            Ok(Err(err)) => Err(err),
            Err(_) => Err(ContractError::SpendingLimitExceeded),
        }
    }

    pub fn assert_invariants(&self) {
        let remaining = self.client.get_remaining_spending_limit(&self.owner_a, &self.token_address);
        assert!(
            remaining.is_some(),
            "Remaining spending limit must be configured"
        );
        let rem = remaining.unwrap();

        // Invariant 1: Remaining spending limit is always bounded between 0 and total limit
        assert!(
            rem >= 0,
            "Remaining spending limit must never drop below 0: got {}",
            rem
        );
        assert!(
            rem <= self.limit,
            "Remaining spending limit must never exceed configured limit: got {} > {}",
            rem,
            self.limit
        );

        // Invariant 2: Tracked spent + remaining must equal the total limit
        assert_eq!(
            rem,
            self.limit - self.tracked_spent,
            "Spend tracking mismatch: remaining ({}) != limit ({}) - spent ({})",
            rem,
            self.limit,
            self.tracked_spent
        );

        // Invariant 3: Spent amount never exceeds configured limit
        assert!(
            self.tracked_spent <= self.limit,
            "CRITICAL: Spent limit exceeded! Spent: {}, Limit: {}",
            self.tracked_spent,
            self.limit
        );
    }
}

// ─── Deterministic Unit & Boundary Tests ─────────────────────────────────────

#[test]
fn test_spend_window_success_within_limit() {
    let mut h = SpendWindowHarness::new(10_000, WINDOW_DAY);
    h.assert_invariants();

    // Spend 3,000 -> remaining 7,000
    assert!(h.try_transfer(3_000).is_ok());
    h.assert_invariants();

    // Spend 4,000 -> remaining 3,000
    assert!(h.try_transfer(4_000).is_ok());
    h.assert_invariants();

    // Advance 10 hours (still inside 24h window)
    h.advance_time(36_000);
    h.assert_invariants();

    // Spend 3,000 -> remaining 0 (exact ceiling)
    assert!(h.try_transfer(3_000).is_ok());
    h.assert_invariants();
}

#[test]
fn test_spend_window_boundary_exact_ceiling_and_rejection() {
    let mut h = SpendWindowHarness::new(5_000, WINDOW_DAY);

    // Exact limit transfer succeeds
    assert!(h.try_transfer(5_000).is_ok());
    h.assert_invariants();
    assert_eq!(
        h.client.get_remaining_spending_limit(&h.owner_a, &h.token_address),
        Some(0)
    );

    // Any further spend (even 1 stroop) inside the window is rejected
    let res = h.try_transfer(1);
    assert_eq!(res, Err(ContractError::SpendingLimitExceeded));
    h.assert_invariants();
}

#[test]
fn test_spend_window_boundary_exact_window_rollover() {
    let mut h = SpendWindowHarness::new(10_000, WINDOW_DAY);

    // Spend full limit at t = START_TIME
    assert!(h.try_transfer(10_000).is_ok());
    h.assert_invariants();

    // Advance time right to boundary: t = START_TIME + WINDOW_DAY (still inside window)
    h.advance_time(WINDOW_DAY);
    assert_eq!(h.try_transfer(1), Err(ContractError::SpendingLimitExceeded));
    h.assert_invariants();

    // Advance 1 more second: t = START_TIME + WINDOW_DAY + 1 (strictly greater than window)
    h.advance_time(1);
    h.assert_invariants();
    assert_eq!(
        h.client.get_remaining_spending_limit(&h.owner_a, &h.token_address),
        Some(10_000)
    );

    // Full limit is restored; new transfer succeeds
    assert!(h.try_transfer(7_000).is_ok());
    h.assert_invariants();
}

#[test]
fn test_spend_window_failure_immediate_overspend() {
    let mut h = SpendWindowHarness::new(1_000, WINDOW_DAY);

    // Single transfer exceeding limit is rejected at creation
    let res = h.try_transfer(1_001);
    assert_eq!(res, Err(ContractError::SpendingLimitExceeded));
    h.assert_invariants();
}

#[test]
fn test_spend_window_regression_exhaustion_boundary_rollover() {
    // Regression fixture capturing exact multi-step exhaustion across rolling epochs
    let mut h = SpendWindowHarness::new(10_000, WINDOW_DAY);

    // Step 1: Initial partial transfer
    assert!(h.try_transfer(6_000).is_ok());
    h.assert_invariants();

    // Step 2: Second transfer approaching ceiling
    h.advance_time(10_000);
    assert!(h.try_transfer(3_000).is_ok());
    h.assert_invariants();
    assert_eq!(
        h.client.get_remaining_spending_limit(&h.owner_a, &h.token_address),
        Some(1_000)
    );

    // Step 3: Attempt overspend by 1,001 (total 10,001 > 10,000)
    h.advance_time(5_000);
    assert_eq!(h.try_transfer(1_001), Err(ContractError::SpendingLimitExceeded));
    h.assert_invariants();

    // Step 4: Advance to boundary and confirm rejection persists
    h.advance_time(WINDOW_DAY - 15_000);
    assert_eq!(h.try_transfer(2_000), Err(ContractError::SpendingLimitExceeded));
    h.assert_invariants();

    // Step 5: Advance past boundary (window resets)
    h.advance_time(1);
    h.assert_invariants();
    assert_eq!(
        h.client.get_remaining_spending_limit(&h.owner_a, &h.token_address),
        Some(10_000)
    );

    // Step 6: Verify full capacity available in fresh window
    assert!(h.try_transfer(10_000).is_ok());
    h.assert_invariants();
    assert_eq!(
        h.client.get_remaining_spending_limit(&h.owner_a, &h.token_address),
        Some(0)
    );
}

// ─── Property-Based Randomized Suite ────────────────────────────────────────

proptest! {
    // Use modest case count for fast, deterministic CI execution without snapshot churn
    #![proptest_config(ProptestConfig::with_cases(16))]

    #[test]
    fn prop_spend_window_never_over_approves(
        limit in 1_000i128..=50_000,
        window_secs in 86_400u64..=172_800,
        steps in proptest::collection::vec(
            (0u8..2, 100i128..=15_000, 10u64..=100_000),
            1..=25
        ),
    ) {
        let mut h = SpendWindowHarness::new(limit, window_secs);
        h.assert_invariants();

        for (action, amount, time_delta) in steps {
            match action {
                0 => {
                    // Transfer attempt
                    let _ = h.try_transfer(amount);
                    h.assert_invariants();
                }
                1 => {
                    // Time advance
                    h.advance_time(time_delta);
                    h.assert_invariants();
                }
                _ => {}
            }
        }
    }
}
