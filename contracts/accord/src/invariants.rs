#![cfg(test)]
#![allow(dead_code)]

//! Randomized-operation property test for the invariants in `docs/INVARIANTS.md`.
//! After every step all state invariants are re-asserted; messages carry the
//! invariant ID so a failure points straight at the doc.

extern crate std;

use super::*;
use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Env, String, Vec};
use std::collections::BTreeMap;
use std::vec::Vec as StdVec;

const NOW: u64 = 1_000;
const POOL: usize = 8;
const MINTED: i128 = 1_000_000_000_000;
const TIMELOCK: u64 = 60;

fn set_timestamp(env: &Env, ts: u64) {
    let mut ledger = env.ledger().get();
    ledger.timestamp = ts;
    env.ledger().set(ledger);
}

/// Per-proposal facts the harness tracks independently of contract storage.
struct Tracked {
    quorum: u32,
    paid: Option<i128>,
    recorded: BTreeMap<usize, u32>,
}

struct Harness {
    env: Env,
    client: AccordContractClient<'static>,
    token: Address,
    treasury: Address,
    pool: StdVec<Address>,
    recipients: StdVec<Address>,
    proposals: StdVec<Tracked>,
}

impl Harness {
    fn new(owner_count: usize, weight: u32, threshold_seed: u32) -> Self {
        let env = Env::new_with_config(soroban_sdk::testutils::EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();
        set_timestamp(&env, NOW);

        let treasury = env.register(AccordContract, ());
        let client = AccordContractClient::new(&env, &treasury);
        let token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        token::StellarAssetClient::new(&env, &token).mint(&treasury, &MINTED);

        let pool: StdVec<Address> = (0..POOL).map(|_| Address::generate(&env)).collect();
        let mut owners = Vec::new(&env);
        let mut weights = Vec::new(&env);
        for owner in pool.iter().take(owner_count) {
            owners.push_back(owner.clone());
            weights.push_back(weight);
        }
        let threshold = threshold_seed % (weight * owner_count as u32) + 1;
        client.initialize(&owners, &weights, &threshold, &TIMELOCK);

        Harness { env, client, token, treasury, pool, recipients: StdVec::new(), proposals: StdVec::new() }
    }

    fn balance(&self, who: &Address) -> i128 {
        token::Client::new(&self.env, &self.token).balance(who)
    }

    fn create(&mut self, actor: usize, target: usize, value: u32) {
        let proposer = self.pool[actor].clone();
        let subject = self.pool[target].clone();
        let deadline = self.env.ledger().timestamp() + 86_400;
        let text = String::from_str(&self.env, "invariant step");
        let threshold = self.client.get_threshold();
        let amount = 1 + i128::from(value);
        let recipient = Address::generate(&self.env);

        let mut transfers = Vec::new(&self.env);
        transfers.push_back(Transfer { to: recipient.clone(), token: self.token.clone(), amount });
        let small = 1 + value % 3;
        let result = match value % 5 {
            0 | 1 => self.client.try_create_proposal(&proposer, &transfers, &text, &deadline, &ProposalCategory::Transfer),
            2 => self.client.try_create_add_owner_proposal(&proposer, &subject, &small, &text, &deadline),
            3 => self.client.try_create_remove_owner_proposal(&proposer, &subject, &text, &deadline),
            _ if value % 2 == 0 => self.client.try_create_change_threshold_proposal(&proposer, &small, &text, &deadline),
            _ => self.client.try_create_change_weight_proposal(&proposer, &subject, &small, &text, &deadline),
        };
        if let Ok(Ok(id)) = result {
            let is_transfer = value % 5 < 2;
            if is_transfer {
                self.recipients.push(recipient);
            }
            assert_eq!(id, self.proposals.len() as u64 + 1, "INV-09: ids are sequential");
            self.proposals.push(Tracked {
                quorum: threshold,
                paid: is_transfer.then_some(amount),
                recorded: BTreeMap::new(),
            });
        }
    }

    fn approve_or_revoke(&mut self, actor: usize, id: u64, approve: bool) {
        let who = self.pool[actor].clone();
        let was_owner = self.client.is_owner(&who);
        let weight = if was_owner { self.client.get_owner_weight(&who) } else { 0 };
        let had = self.client.has_approved(&id, &who);
        let accepted = if approve {
            matches!(self.client.try_approve(&who, &id), Ok(Ok(_)))
        } else {
            matches!(self.client.try_revoke(&who, &id), Ok(Ok(_)))
        };
        let tracked = &mut self.proposals[id as usize - 1];
        if approve {
            assert!(!(accepted && had), "INV-04: owner approved twice");
            assert!(!accepted || was_owner, "INV-04: non-owner approved");
            if accepted {
                tracked.recorded.insert(actor, weight);
            }
        } else if accepted {
            assert!(had, "INV-04: revoked without approving");
            tracked.recorded.remove(&actor);
        }
    }

    fn execute(&mut self, actor: usize, id: u64) {
        let who = self.pool[actor].clone();
        let before = self.client.get_proposal(&id);
        let now = self.env.ledger().timestamp();
        if matches!(self.client.try_execute(&who, &id), Ok(Ok(_))) {
            assert!(
                matches!(before.status, ProposalStatus::Pending | ProposalStatus::Ready),
                "INV-06: executed twice"
            );
            assert!(before.approvals >= before.quorum_weight, "INV-06: executed below quorum");
            assert!(now <= before.deadline, "INV-06: executed after deadline");
            assert!(now >= before.ready_at + TIMELOCK, "INV-07: executed inside time-lock");
        }
    }

    fn check(&self) -> Result<(), TestCaseError> {
        let weights = self.client.get_owner_weights();
        let sum: u32 = weights.iter().map(|w| w.weight).sum();
        let total = self.client.get_total_weight();
        let threshold = self.client.get_threshold();
        prop_assert_eq!(sum, total, "INV-01: total weight != sum of owner weights");
        prop_assert!(threshold >= 1 && threshold <= total, "INV-02: threshold {} outside 1..={}", threshold, total);
        prop_assert!(weights.len() >= 1 && weights.len() <= MAX_OWNERS, "INV-03: owner count out of bounds");

        let now = self.env.ledger().timestamp();
        let (mut live, mut paid_total) = (0u32, 0i128);
        for (index, tracked) in self.proposals.iter().enumerate() {
            let id = index as u64 + 1;
            let p = self.client.get_proposal(&id);
            prop_assert_eq!(p.quorum_weight, tracked.quorum, "INV-05: quorum of {} changed", id);
            if matches!(p.status, ProposalStatus::Pending | ProposalStatus::Ready) {
                let expected: u32 = (0..POOL)
                    .filter(|i| self.client.has_approved(&id, &self.pool[*i]))
                    .map(|i| tracked.recorded.get(&i).copied().unwrap_or(0))
                    .sum();
                prop_assert_eq!(p.approvals, expected, "INV-04: approvals of {} != sum of approver weights", id);
                live += u32::from(now <= p.deadline);
            }
            if p.status == ProposalStatus::Executed {
                paid_total += tracked.paid.unwrap_or(0);
            }
        }
        prop_assert!(live <= MAX_ACTIVE_PROPOSALS, "INV-08: {} live proposals exceed the cap", live);

        let received: i128 = self.recipients.iter().map(|r| self.balance(r)).sum();
        prop_assert_eq!(self.balance(&self.treasury), MINTED - paid_total, "INV-10: treasury != minted - executed transfers");
        prop_assert_eq!(received, paid_total, "INV-10: recipients received other than executed transfers");
        Ok(())
    }
}

proptest! {
    // Soroban builds a fresh Env per case and each step re-reads full state, so keep cases modest.
    #![proptest_config(ProptestConfig::with_cases(16))]

    /// Every invariant in docs/INVARIANTS.md holds after every step of a random
    /// operation sequence (create, approve, revoke, execute, time passing).
    #[test]
    fn invariants_hold_under_randomized_operations(
        owner_count in 3usize..=5,
        weight in 1u32..=3,
        threshold_seed in 0u32..1_000,
        steps in proptest::collection::vec(
            (0u8..5, 0usize..POOL, 0usize..POOL, 0u32..1_000_000, 0u32..6),
            1..=40
        ),
    ) {
        let mut h = Harness::new(owner_count, weight, threshold_seed);
        h.check()?;
        for (kind, actor, target, value, recent) in steps {
            let total = h.proposals.len() as u64;
            let id = (total > 0).then(|| total - u64::from(recent) % total.min(6));
            match (kind, id) {
                (0, _) => h.create(actor, target, value),
                (1, Some(id)) => h.approve_or_revoke(actor, id, true),
                (2, Some(id)) => h.approve_or_revoke(actor, id, false),
                (3, Some(id)) => {
                    // Everyone approves, then someone executes.
                    for owner in 0..POOL {
                        h.approve_or_revoke(owner, id, true);
                    }
                    h.execute(actor, id);
                }
                (4, _) => {
                    let now = h.env.ledger().timestamp();
                    set_timestamp(&h.env, now + [1u64, 61, 3_600, 100_000][value as usize % 4]);
                }
                _ => {}
            }
            h.check()?;
        }
    }
}
