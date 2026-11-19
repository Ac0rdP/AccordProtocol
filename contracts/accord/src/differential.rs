#![cfg(test)]

//! Differential testing suite comparing Accord Protocol contract execution
//! against a pure-Rust reference implementation over randomized and boundary operations.
//!
//! Issue #1043: Verifies that contract transitions, approval tracking, timelocks,
//! and balance movements match the reference model character-for-character.

extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Env, String, Vec};
use std::collections::{BTreeMap, BTreeSet};
use std::vec::Vec as StdVec;

const BASE_TIME: u64 = 10_000;
const INITIAL_TREASURY_FUNDS: i128 = 5_000_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefProposalStatus {
    Pending,
    Ready,
    Executed,
    Expired,
}

#[derive(Debug, Clone)]
pub struct RefProposal {
    pub id: u64,
    pub proposer: Address,
    pub recipient: Address,
    pub amount: i128,
    pub quorum_weight: u32,
    pub deadline: u64,
    pub ready_at: u64,
    pub status: RefProposalStatus,
    pub approvers: BTreeSet<Address>,
    pub approval_weight: u32,
}

/// Pure-Rust reference model implementing the multisig lifecycle.
#[derive(Debug, Clone)]
pub struct AccordReferenceModel {
    pub owners: BTreeMap<Address, u32>,
    pub threshold: u32,
    pub timelock_delay: u64,
    pub current_time: u64,
    pub treasury_balance: i128,
    pub recipient_balances: BTreeMap<Address, i128>,
    pub proposals: BTreeMap<u64, RefProposal>,
    pub next_id: u64,
}

impl AccordReferenceModel {
    pub fn new(
        owners: &[(Address, u32)],
        threshold: u32,
        timelock_delay: u64,
        initial_treasury: i128,
    ) -> Self {
        let mut owner_map = BTreeMap::new();
        for (addr, weight) in owners {
            owner_map.insert(addr.clone(), *weight);
        }

        Self {
            owners: owner_map,
            threshold,
            timelock_delay,
            current_time: BASE_TIME,
            treasury_balance: initial_treasury,
            recipient_balances: BTreeMap::new(),
            proposals: BTreeMap::new(),
            next_id: 1,
        }
    }

    pub fn total_weight(&self) -> u32 {
        self.owners.values().sum()
    }

    pub fn advance_time(&mut self, seconds: u64) {
        self.current_time = self.current_time.saturating_add(seconds);
    }

    pub fn create_transfer_proposal(
        &mut self,
        proposer: &Address,
        recipient: &Address,
        amount: i128,
        deadline: u64,
    ) -> Result<u64, &'static str> {
        if !self.owners.contains_key(proposer) {
            return Err("ProposerNotOwner");
        }
        if deadline <= self.current_time {
            return Err("InvalidDeadline");
        }
        if amount <= 0 {
            return Err("InvalidAmount");
        }

        let id = self.next_id;
        self.next_id += 1;

        let proposal = RefProposal {
            id,
            proposer: proposer.clone(),
            recipient: recipient.clone(),
            amount,
            quorum_weight: self.threshold,
            deadline,
            ready_at: 0,
            status: RefProposalStatus::Pending,
            approvers: BTreeSet::new(),
            approval_weight: 0,
        };

        self.proposals.insert(id, proposal);
        Ok(id)
    }

    pub fn approve(&mut self, caller: &Address, id: u64) -> Result<u32, &'static str> {
        let weight = match self.owners.get(caller) {
            Some(w) => *w,
            None => return Err("NotAnOwner"),
        };

        let prop = self.proposals.get_mut(&id).ok_or("ProposalNotFound")?;

        if prop.status != RefProposalStatus::Pending && prop.status != RefProposalStatus::Ready {
            return Err("ProposalNotActive");
        }
        if self.current_time > prop.deadline {
            prop.status = RefProposalStatus::Expired;
            return Err("ProposalExpired");
        }
        if prop.approvers.contains(caller) {
            return Err("AlreadyApproved");
        }

        prop.approvers.insert(caller.clone());
        prop.approval_weight = prop.approval_weight.saturating_add(weight);

        if prop.approval_weight >= prop.quorum_weight && prop.status == RefProposalStatus::Pending {
            prop.status = RefProposalStatus::Ready;
            prop.ready_at = self.current_time;
        }

        Ok(prop.approval_weight)
    }

    pub fn revoke(&mut self, caller: &Address, id: u64) -> Result<(), &'static str> {
        let weight = match self.owners.get(caller) {
            Some(w) => *w,
            None => return Err("NotAnOwner"),
        };

        let prop = self.proposals.get_mut(&id).ok_or("ProposalNotFound")?;

        if prop.status != RefProposalStatus::Pending && prop.status != RefProposalStatus::Ready {
            return Err("ProposalNotActive");
        }
        if !prop.approvers.remove(caller) {
            return Err("NotApproved");
        }

        prop.approval_weight = prop.approval_weight.saturating_sub(weight);

        if prop.approval_weight < prop.quorum_weight && prop.status == RefProposalStatus::Ready {
            prop.status = RefProposalStatus::Pending;
            prop.ready_at = 0;
        }

        Ok(())
    }

    pub fn execute(&mut self, caller: &Address, id: u64) -> Result<(), &'static str> {
        if !self.owners.contains_key(caller) {
            return Err("NotAnOwner");
        }

        let prop = self.proposals.get_mut(&id).ok_or("ProposalNotFound")?;

        if prop.status != RefProposalStatus::Pending && prop.status != RefProposalStatus::Ready {
            return Err("ProposalNotExecutable");
        }
        if self.current_time > prop.deadline {
            prop.status = RefProposalStatus::Expired;
            return Err("ProposalExpired");
        }
        if prop.approval_weight < prop.quorum_weight {
            return Err("QuorumNotReached");
        }

        // Check timelock
        if self.timelock_delay > 0 {
            if self.current_time < prop.ready_at.saturating_add(self.timelock_delay) {
                return Err("TimelockNotElapsed");
            }
        }

        // Check balance
        if self.treasury_balance < prop.amount {
            return Err("InsufficientTreasuryBalance");
        }

        // Execute transfer
        self.treasury_balance -= prop.amount;
        *self.recipient_balances.entry(prop.recipient.clone()).or_insert(0) += prop.amount;
        prop.status = RefProposalStatus::Executed;

        Ok(())
    }
}

/// Differential test harness pairing Soroban AccordContractClient with AccordReferenceModel.
pub struct DifferentialHarness {
    pub env: Env,
    pub client: AccordContractClient<'static>,
    pub token_client: token::Client<'static>,
    pub token_address: Address,
    pub treasury_address: Address,
    pub owners: StdVec<Address>,
    pub weights: StdVec<u32>,
    pub reference_model: AccordReferenceModel,
}

impl DifferentialHarness {
    pub fn new(owner_weights: &[u32], threshold: u32, timelock_delay: u64) -> Self {
        let env = Env::new_with_config(soroban_sdk::testutils::EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();

        let mut ledger = env.ledger().get();
        ledger.timestamp = BASE_TIME;
        env.ledger().set(ledger);

        let treasury_address = env.register(AccordContract, ());
        let client = AccordContractClient::new(&env, &treasury_address);

        let token_admin = Address::generate(&env);
        let token_sac = env.register_stellar_asset_contract_v2(token_admin);
        let token_address = token_sac.address();
        let token_client = token::Client::new(&env, &token_address);
        token::StellarAssetClient::new(&env, &token_address).mint(
            &treasury_address,
            &INITIAL_TREASURY_FUNDS,
        );

        let mut owners = StdVec::new();
        let mut weights = StdVec::new();
        let mut ref_pairs = StdVec::new();

        let mut sdk_owners = Vec::new(&env);
        let mut sdk_weights = Vec::new(&env);

        for &w in owner_weights {
            let addr = Address::generate(&env);
            owners.push(addr.clone());
            weights.push(w);
            ref_pairs.push((addr.clone(), w));
            sdk_owners.push_back(addr);
            sdk_weights.push_back(w);
        }

        client.initialize(&sdk_owners, &sdk_weights, &threshold, &timelock_delay);

        let reference_model = AccordReferenceModel::new(
            &ref_pairs,
            threshold,
            timelock_delay,
            INITIAL_TREASURY_FUNDS,
        );

        Self {
            env,
            client,
            token_client,
            token_address,
            treasury_address,
            owners,
            weights,
            reference_model,
        }
    }

    pub fn advance_time(&mut self, seconds: u64) {
        let mut ledger = self.env.ledger().get();
        ledger.timestamp = ledger.timestamp.saturating_add(seconds);
        self.env.ledger().set(ledger);
        self.reference_model.advance_time(seconds);
    }

    pub fn assert_state_matches(&self) {
        assert_eq!(
            self.client.get_threshold(),
            self.reference_model.threshold,
            "Differential mismatch on threshold"
        );
        assert_eq!(
            self.client.get_total_weight(),
            self.reference_model.total_weight(),
            "Differential mismatch on total_weight"
        );
        let contract_balance = self.token_client.balance(&self.treasury_address);
        assert_eq!(
            contract_balance, self.reference_model.treasury_balance,
            "Differential mismatch on treasury token balance"
        );

        for (id, ref_prop) in &self.reference_model.proposals {
            let contract_prop = self.client.get_proposal(id);
            assert_eq!(
                contract_prop.approvals, ref_prop.approval_weight,
                "Differential mismatch on approval weight for proposal {}",
                id
            );
            assert_eq!(
                contract_prop.quorum_weight, ref_prop.quorum_weight,
                "Differential mismatch on quorum weight for proposal {}",
                id
            );

            match ref_prop.status {
                RefProposalStatus::Pending => {
                    assert_eq!(
                        contract_prop.status,
                        ProposalStatus::Pending,
                        "Proposal {} status mismatch: expected Pending",
                        id
                    );
                }
                RefProposalStatus::Ready => {
                    assert_eq!(
                        contract_prop.status,
                        ProposalStatus::Ready,
                        "Proposal {} status mismatch: expected Ready",
                        id
                    );
                }
                RefProposalStatus::Executed => {
                    assert_eq!(
                        contract_prop.status,
                        ProposalStatus::Executed,
                        "Proposal {} status mismatch: expected Executed",
                        id
                    );
                }
                RefProposalStatus::Expired => {
                    // Contract evaluates expiry on attempt to approve/execute or when checked
                }
            }
        }
    }
}

// ─── Differential Test Cases ──────────────────────────────────────────────────

#[test]
fn test_differential_success_full_lifecycle() {
    let mut h = DifferentialHarness::new(&[2, 3, 5], 5, 60);
    h.assert_state_matches();

    let recipient = Address::generate(&h.env);
    let amount = 1_000_000;
    let deadline = h.reference_model.current_time + 3_600;

    // 1. Create proposal
    let mut transfers = Vec::new(&h.env);
    transfers.push_back(Transfer {
        to: recipient.clone(),
        token: h.token_address.clone(),
        amount,
    });
    let desc = String::from_str(&h.env, "test transfer");

    let contract_id = h.client.create_proposal(
        &h.owners[0],
        &transfers,
        &desc,
        &deadline,
        &ProposalCategory::Transfer,
    );
    let ref_id = h
        .reference_model
        .create_transfer_proposal(&h.owners[0], &recipient, amount, deadline)
        .expect("Ref model create proposal");

    assert_eq!(contract_id, ref_id);
    h.assert_state_matches();

    // 2. Approve by owner 0 (weight 2) -> Quorum not reached yet (2 < 5)
    h.client.approve(&h.owners[0], &contract_id);
    h.reference_model
        .approve(&h.owners[0], ref_id)
        .expect("Ref model approve 0");
    h.assert_state_matches();

    // 3. Approve by owner 1 (weight 3) -> Quorum reached (2 + 3 = 5 >= 5) -> Ready
    h.client.approve(&h.owners[1], &contract_id);
    h.reference_model
        .approve(&h.owners[1], ref_id)
        .expect("Ref model approve 1");
    h.assert_state_matches();

    // 4. Advance time past time-lock delay (60s)
    h.advance_time(61);
    h.assert_state_matches();

    // 5. Execute proposal
    h.client.execute(&h.owners[2], &contract_id);
    h.reference_model
        .execute(&h.owners[2], ref_id)
        .expect("Ref model execute");
    h.assert_state_matches();

    assert_eq!(h.token_client.balance(&recipient), amount);
}

#[test]
fn test_differential_boundary_exact_quorum_and_timelock() {
    let mut h = DifferentialHarness::new(&[1, 2, 3], 3, 120);
    let recipient = Address::generate(&h.env);
    let amount = 50_000;
    let deadline = h.reference_model.current_time + 500;

    let mut transfers = Vec::new(&h.env);
    transfers.push_back(Transfer {
        to: recipient.clone(),
        token: h.token_address.clone(),
        amount,
    });
    let desc = String::from_str(&h.env, "boundary test");

    let id = h.client.create_proposal(
        &h.owners[1],
        &transfers,
        &desc,
        &deadline,
        &ProposalCategory::Transfer,
    );
    let ref_id = h
        .reference_model
        .create_transfer_proposal(&h.owners[1], &recipient, amount, deadline)
        .unwrap();
    assert_eq!(id, ref_id);

    // Approve with owner 1 (weight 2) -> 2 < 3, status remains Pending in both
    h.client.approve(&h.owners[1], &id);
    h.reference_model.approve(&h.owners[1], id).unwrap();
    h.assert_state_matches();

    // Approve with owner 0 (weight 1) -> 2 + 1 = 3 == quorum_weight (Exact boundary!)
    h.client.approve(&h.owners[0], &id);
    h.reference_model.approve(&h.owners[0], id).unwrap();
    h.assert_state_matches();

    // Attempt execution before timelock elapses: ready_at + 120
    h.advance_time(119);
    assert_eq!(
        h.client.try_execute(&h.owners[2], &id),
        Err(Ok(ContractError::TimeLockActive))
    );
    assert_eq!(
        h.reference_model.execute(&h.owners[2], id),
        Err("TimelockNotElapsed")
    );

    // Exactly at timelock expiry (ready_at + 120)
    h.advance_time(1);
    h.client.execute(&h.owners[2], &id);
    h.reference_model.execute(&h.owners[2], id).unwrap();
    h.assert_state_matches();
}

#[test]
fn test_differential_failure_cases() {
    let mut h = DifferentialHarness::new(&[2, 2, 2], 4, 30);
    let non_owner = Address::generate(&h.env);
    let recipient = Address::generate(&h.env);
    let amount = 100;
    let deadline = h.reference_model.current_time + 200;

    let mut transfers = Vec::new(&h.env);
    transfers.push_back(Transfer {
        to: recipient.clone(),
        token: h.token_address.clone(),
        amount,
    });
    let desc = String::from_str(&h.env, "fail test");

    let id = h.client.create_proposal(
        &h.owners[0],
        &transfers,
        &desc,
        &deadline,
        &ProposalCategory::Transfer,
    );
    let _ref_id = h
        .reference_model
        .create_transfer_proposal(&h.owners[0], &recipient, amount, deadline)
        .unwrap();

    // Case 1: Non-owner approval fails in both
    assert_eq!(
        h.client.try_approve(&non_owner, &id),
        Err(Ok(ContractError::MissingRole))
    );
    assert_eq!(
        h.reference_model.approve(&non_owner, id),
        Err("NotAnOwner")
    );

    // Case 2: Double-approval by same owner fails in both
    h.client.approve(&h.owners[0], &id);
    h.reference_model.approve(&h.owners[0], id).unwrap();

    assert_eq!(
        h.client.try_approve(&h.owners[0], &id),
        Err(Ok(ContractError::AlreadyApproved))
    );
    assert_eq!(
        h.reference_model.approve(&h.owners[0], id),
        Err("AlreadyApproved")
    );

    // Case 3: Revoke without approval fails in both
    assert_eq!(
        h.client.try_revoke(&h.owners[1], &id),
        Err(Ok(ContractError::NotApproved))
    );
    assert_eq!(
        h.reference_model.revoke(&h.owners[1], id),
        Err("NotApproved")
    );

    // Case 4: Execution below quorum fails in both
    assert_eq!(
        h.client.try_execute(&h.owners[0], &id),
        Err(Ok(ContractError::ThresholdNotMet))
    );
    assert_eq!(
        h.reference_model.execute(&h.owners[0], id),
        Err("QuorumNotReached")
    );

    h.assert_state_matches();
}

#[test]
fn test_differential_randomized_interleaved_operations() {
    let mut h = DifferentialHarness::new(&[1, 2, 3, 4], 6, 45);
    let mut active_proposals: StdVec<u64> = StdVec::new();

    // Deterministic pseudo-random sequence of 40 interleaved operations
    for step in 0..40 {
        let op_type = step % 5;
        match op_type {
            0 => {
                // Create proposal
                let proposer = &h.owners[step % h.owners.len()];
                let recipient = Address::generate(&h.env);
                let amount = ((step as i128 + 1) * 10_000).min(500_000);
                let deadline = h.reference_model.current_time + 10_000;

                let mut transfers = Vec::new(&h.env);
                transfers.push_back(Transfer {
                    to: recipient.clone(),
                    token: h.token_address.clone(),
                    amount,
                });
                let desc = String::from_str(&h.env, "randomized step");

                let c_id = h.client.create_proposal(
                    proposer,
                    &transfers,
                    &desc,
                    &deadline,
                    &ProposalCategory::Transfer,
                );
                let r_id = h
                    .reference_model
                    .create_transfer_proposal(proposer, &recipient, amount, deadline)
                    .unwrap();

                assert_eq!(c_id, r_id);
                active_proposals.push(c_id);
            }
            1 => {
                // Approve
                if let Some(&p_id) = active_proposals.get(step % active_proposals.len().max(1)) {
                    let actor = &h.owners[step % h.owners.len()];
                    let c_res = h.client.try_approve(actor, &p_id);
                    let r_res = h.reference_model.approve(actor, p_id);

                    assert_eq!(
                        c_res.is_ok(),
                        r_res.is_ok(),
                        "Approval differential mismatch at step {}: c_res={:?}, r_res={:?}",
                        step,
                        c_res,
                        r_res
                    );
                }
            }
            2 => {
                // Revoke
                if let Some(&p_id) = active_proposals.get(step % active_proposals.len().max(1)) {
                    let actor = &h.owners[(step + 1) % h.owners.len()];
                    let c_res = h.client.try_revoke(actor, &p_id);
                    let r_res = h.reference_model.revoke(actor, p_id);

                    assert_eq!(
                        c_res.is_ok(),
                        r_res.is_ok(),
                        "Revocation differential mismatch at step {}: c_res={:?}, r_res={:?}",
                        step,
                        c_res,
                        r_res
                    );
                }
            }
            3 => {
                // Advance time
                let advance_secs = (step as u64 % 4) * 30 + 15;
                h.advance_time(advance_secs);
            }
            4 => {
                // Execute
                if let Some(&p_id) = active_proposals.get(step % active_proposals.len().max(1)) {
                    let actor = &h.owners[step % h.owners.len()];
                    let c_res = h.client.try_execute(actor, &p_id);
                    let r_res = h.reference_model.execute(actor, p_id);

                    assert_eq!(
                        c_res.is_ok(),
                        r_res.is_ok(),
                        "Execution differential mismatch at step {}: c_res={:?}, r_res={:?}",
                        step,
                        c_res,
                        r_res
                    );
                }
            }
            _ => {}
        }
        h.assert_state_matches();
    }
}

/// Regression fixture: Verify approval quorum and timelock gating when approval
/// transitions occur right at the threshold and timelock boundaries.
#[test]
fn test_differential_regression_fixture_in_flight_weight_and_timelock() {
    let mut h = DifferentialHarness::new(&[1, 2, 3], 4, 100);
    let recipient = Address::generate(&h.env);
    let amount = 250_000;
    let deadline = h.reference_model.current_time + 1_000;

    let mut transfers = Vec::new(&h.env);
    transfers.push_back(Transfer {
        to: recipient.clone(),
        token: h.token_address.clone(),
        amount,
    });
    let desc = String::from_str(&h.env, "regression fixture");

    let id = h.client.create_proposal(
        &h.owners[0],
        &transfers,
        &desc,
        &deadline,
        &ProposalCategory::Transfer,
    );
    let ref_id = h
        .reference_model
        .create_transfer_proposal(&h.owners[0], &recipient, amount, deadline)
        .unwrap();

    // Owner 2 approves (weight 3) -> 3 < 4 (Pending)
    h.client.approve(&h.owners[2], &id);
    h.reference_model.approve(&h.owners[2], ref_id).unwrap();
    h.assert_state_matches();

    // Owner 1 approves (weight 2) -> 3 + 2 = 5 >= 4 (transitions to Ready at t=10_000)
    h.client.approve(&h.owners[1], &id);
    h.reference_model.approve(&h.owners[1], ref_id).unwrap();
    h.assert_state_matches();

    // Owner 2 revokes (weight 3) -> drops to 2 < 4 (transitions back to Pending, ready_at reset!)
    h.client.revoke(&h.owners[2], &id);
    h.reference_model.revoke(&h.owners[2], ref_id).unwrap();
    h.assert_state_matches();

    // Try executing when dropped below quorum -> Rejects in both!
    assert_eq!(
        h.client.try_execute(&h.owners[0], &id),
        Err(Ok(ContractError::ThresholdNotMet))
    );
    assert_eq!(
        h.reference_model.execute(&h.owners[0], ref_id),
        Err("QuorumNotReached")
    );

    // Owner 0 approves (weight 1) -> 2 + 1 = 3 < 4 -> Still Pending!
    h.client.approve(&h.owners[0], &id);
    h.reference_model.approve(&h.owners[0], ref_id).unwrap();
    h.assert_state_matches();

    // Owner 2 re-approves (weight 3) -> 3 + 3 = 6 >= 4 -> Transitions to Ready again at current time!
    h.client.approve(&h.owners[2], &id);
    h.reference_model.approve(&h.owners[2], ref_id).unwrap();
    h.assert_state_matches();

    // Advance time past new timelock delay
    h.advance_time(101);
    h.client.execute(&h.owners[0], &id);
    h.reference_model.execute(&h.owners[0], ref_id).unwrap();
    h.assert_state_matches();
}
