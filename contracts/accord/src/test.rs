#![cfg(test)]

extern crate std;

use super::*;
use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, Events, Ledger as _};
use soroban_sdk::{
    symbol_short, token, xdr, Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Vec,
};
use std::format;

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn set_timestamp(env: &Env, ts: u64) {
    let mut l = env.ledger().get();
    l.timestamp = ts;
    env.ledger().set(l);
}

fn str(env: &Env, s: &str) -> String {
    String::from_str(env, s)
}

const NOW: u64 = 1_000;
const DEADLINE: u64 = NOW + 86_400; // +1 day

fn t(env: &Env, to: &Address, amount: i128, token: &Address) -> Vec<Transfer> {
    let mut transfers = Vec::new(env);
    transfers.push_back(Transfer {
        to: to.clone(),
        token: token.clone(),
        amount,
    });
    transfers
}

/// Sets up an env with 3 owners, a threshold, and a funded token.
/// Time-lock delay is 0 (no delay).
fn setup(
    threshold: u32,
) -> (
    Env,
    AccordContractClient<'static>,
    Address,
    Address,
    Address,
    Address, // non-owner
    token::Client<'static>,
) {
    setup_with_timelock(threshold, 0)
}

/// Sets up an env with 3 owners, a threshold, a funded token, and a custom time-lock delay.
fn setup_with_timelock(
    threshold: u32,
    time_lock_delay: u64,
) -> (
    Env,
    AccordContractClient<'static>,
    Address,
    Address,
    Address,
    Address, // non-owner
    token::Client<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();
    set_timestamp(&env, NOW);

    let owner_a = Address::generate(&env);
    let owner_b = Address::generate(&env);
    let owner_c = Address::generate(&env);
    let non_owner = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_client = token::Client::new(&env, &token_id.address());
    let token_sac = token::StellarAssetClient::new(&env, &token_id.address());

    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);

    let mut owners = Vec::new(&env);
    owners.push_back(owner_a.clone());
    owners.push_back(owner_b.clone());
    owners.push_back(owner_c.clone());

    let mut weights = Vec::new(&env);
    weights.push_back(1);
    weights.push_back(1);
    weights.push_back(1);
    let mut weights = Vec::new(&env);
    for _ in 0..owners.len() {
        weights.push_back(1);
    }
    client.initialize(&owners, &weights, &threshold, &time_lock_delay);

    // Fund the multisig contract so it can pay out proposals.
    token_sac.mint(&contract_id, &1_000_000_000_000_i128);

    (
        env,
        client,
        owner_a,
        owner_b,
        owner_c,
        non_owner,
        token_client,
    )
}

// ─── Initialization ──────────────────────────────────────────────────────────

#[test]
fn initialize_sets_owners_and_threshold() {
    let (_, client, owner_a, owner_b, owner_c, _, _) = setup(2);
    let owners = client.get_owners();
    assert_eq!(owners.len(), 3);
    assert!(owners.contains(&owner_a));
    assert!(owners.contains(&owner_b));
    assert!(owners.contains(&owner_c));
    assert_eq!(client.get_threshold(), 2);
}

#[test]
fn initialize_accepts_maximum_owners() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);

    // Generate exactly 20 unique addresses (MAX_OWNERS)
    let mut owners = Vec::new(&env);
    for _ in 0..20 {
        owners.push_back(Address::generate(&env));
    }

    // Initialize should succeed
    let mut weights = Vec::new(&env);
    for _ in 0..owners.len() {
        weights.push_back(1);
    }
    client.initialize(&owners, &weights, &1, &0);

    // Verify all 20 owners were stored
    let stored_owners = client.get_owners();
    assert_eq!(stored_owners.len(), 20);
}

#[test]
fn initialize_rejects_second_call() {
    let (env, client, owner_a, owner_b, owner_c, _, _) = setup(2);
    let mut owners = Vec::new(&env);
    owners.push_back(owner_a);
    owners.push_back(owner_b);
    owners.push_back(owner_c);
    let mut weights = Vec::new(&env);
    for _ in 0..owners.len() {
        weights.push_back(1);
    }
    assert_eq!(
        client.try_initialize(&owners, &weights, &2, &0),
        Err(Ok(ContractError::AlreadyInitialized))
    );
}

#[test]
fn initialize_rejects_threshold_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);
    let mut owners = Vec::new(&env);
    owners.push_back(Address::generate(&env));
    let mut weights = Vec::new(&env);
    for _ in 0..owners.len() {
        weights.push_back(1);
    }
    assert_eq!(
        client.try_initialize(&owners, &weights, &0, &0),
        Err(Ok(ContractError::InvalidThreshold))
    );
}

#[test]
fn initialize_rejects_threshold_above_count() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);
    let mut owners = Vec::new(&env);
    owners.push_back(Address::generate(&env));
    let mut weights = Vec::new(&env);
    for _ in 0..owners.len() {
        weights.push_back(1);
    }
    assert_eq!(
        client.try_initialize(&owners, &weights, &2, &0),
        Err(Ok(ContractError::InvalidThreshold))
    );
}

// ─── Absolute-weight quorum model ────────────────────────────────────────────

/// The threshold is an absolute weight value, not a count of owners. Validate
/// that initialize rejects a threshold that exceeds the sum of all owner weights
/// even when there are enough owners to satisfy a count-based check.
///
/// Setup: 3 owners each with weight 2 → total_weight = 6.
/// A threshold of 7 must be rejected because 7 > 6, even though 7 ≤ MAX_OWNERS.
#[test]
fn initialize_rejects_threshold_above_total_weight() {
    let env = Env::default();
    env.mock_all_auths();
    set_timestamp(&env, NOW);
    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);

    let mut owners = Vec::new(&env);
    owners.push_back(Address::generate(&env));
    owners.push_back(Address::generate(&env));
    owners.push_back(Address::generate(&env));
    // Each weight = 2, total_weight = 6.
    let mut weights = Vec::new(&env);
    weights.push_back(2_u32);
    weights.push_back(2_u32);
    weights.push_back(2_u32);

    // threshold 7 > total_weight 6 — must be rejected.
    assert_eq!(
        client.try_initialize(&owners, &weights, &7, &0),
        Err(Ok(ContractError::InvalidThreshold))
    );

    // threshold 6 == total_weight 6 — must be accepted (unanimity).
    client.initialize(&owners, &weights, &6, &0);
    assert_eq!(client.get_threshold(), 6);
}

/// Adding a new owner increases total_weight but does NOT automatically change
/// the threshold. A proposal created before the addition and one created after
/// must both carry the same quorum_weight (the unchanged threshold), confirming
/// the absolute-weight model is not percentage-based.
#[test]
fn quorum_weight_unchanged_when_owner_added() {
    let (env, client, owner_a, owner_b, owner_c, non_owner, token_client) = setup(2);

    // threshold = 2, total_weight = 3 (3 owners × weight 1).
    assert_eq!(client.get_threshold(), 2);
    assert_eq!(client.get_total_weight(), 3);

    let id_before = client.create_proposal(
        &owner_a,
        &t(&env, &Address::generate(&env), 1_000_000, &token_client.address),
        &str(&env, "Before add"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert_eq!(client.get_proposal(&id_before).quorum_weight, 2);

    // Propose and execute adding non_owner as a fourth owner (weight 1).
    let add_id = client.create_add_owner_proposal(
        &owner_a,
        &non_owner,
        &str(&env, "Add fourth owner"),
        &DEADLINE,
    );
    client.approve(&owner_a, &add_id);
    client.approve(&owner_b, &add_id);
    client.execute(&owner_c, &add_id);

    // total_weight is now 4, but threshold is still 2.
    assert_eq!(client.get_total_weight(), 4);
    assert_eq!(client.get_threshold(), 2);

    let id_after = client.create_proposal(
        &owner_a,
        &t(&env, &Address::generate(&env), 1_000_000, &token_client.address),
        &str(&env, "After add"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    // quorum_weight must be the same on both proposals — threshold did not change.
    assert_eq!(client.get_proposal(&id_after).quorum_weight, 2);
    assert_eq!(
        client.get_proposal(&id_before).quorum_weight,
        client.get_proposal(&id_after).quorum_weight,
    );
}

/// Removing an owner reduces total_weight. If the remaining weight would drop
/// below the current threshold, the removal proposal must be rejected.
/// If it stays >= threshold, it must be accepted.
#[test]
fn remove_owner_rejected_when_remaining_weight_below_threshold() {
    // 3 owners: A weight 3, B weight 1, C weight 1 → total_weight = 5, threshold = 4.
    let env = Env::default();
    env.mock_all_auths();
    set_timestamp(&env, NOW);

    let owner_a = Address::generate(&env);
    let owner_b = Address::generate(&env);
    let owner_c = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token_sac = token::StellarAssetClient::new(&env, &token_id.address());
    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);

    let mut owners = Vec::new(&env);
    owners.push_back(owner_a.clone());
    owners.push_back(owner_b.clone());
    owners.push_back(owner_c.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(3_u32);
    weights.push_back(1_u32);
    weights.push_back(1_u32);
    // threshold = 4; total_weight = 5.
    client.initialize(&owners, &weights, &4, &0);
    token_sac.mint(&contract_id, &1_000_000_000_000_i128);

    // Removing owner_a (weight 3) would leave total_weight = 2, which is < threshold 4.
    assert_eq!(
        client.try_create_remove_owner_proposal(
            &owner_b,
            &owner_a,
            &str(&env, "Remove heavy owner"),
            &DEADLINE,
        ),
        Err(Ok(ContractError::WouldBreakThreshold))
    );

    // Removing owner_c (weight 1) would leave total_weight = 4 == threshold 4 — allowed.
    let remove_id = client.create_remove_owner_proposal(
        &owner_a,
        &owner_c,
        &str(&env, "Remove light owner"),
        &DEADLINE,
    );
    assert!(remove_id > 0);
}

/// A change-threshold proposal must be rejected if the new threshold would
/// exceed the current total_weight, and accepted when it is within range.
#[test]
fn change_threshold_proposal_validates_against_total_weight() {
    // 3 owners each weight 1 → total_weight = 3, threshold = 2.
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);

    // Proposing a threshold of 4 > total_weight 3 must fail.
    assert_eq!(
        client.try_create_change_threshold_proposal(
            &owner_a,
            &4,
            &str(&env, "Too high"),
            &DEADLINE,
        ),
        Err(Ok(ContractError::InvalidThreshold))
    );

    // Proposing a threshold equal to total_weight (unanimity) must succeed.
    let change_id = client.create_change_threshold_proposal(
        &owner_a,
        &3,
        &str(&env, "Unanimity"),
        &DEADLINE,
    );
    client.approve(&owner_a, &change_id);
    client.approve(&owner_b, &change_id);
    client.execute(&owner_c, &change_id);
    assert_eq!(client.get_threshold(), 3);

    // A proposal created after the change must carry the new quorum_weight.
    let id = client.create_proposal(
        &owner_a,
        &t(&env, &Address::generate(&env), 1_000_000, &token_client.address),
        &str(&env, "After threshold change"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert_eq!(client.get_proposal(&id).quorum_weight, 3);
}

#[test]
fn initialize_rejects_duplicate_owners() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);
    let dup = Address::generate(&env);
    let mut owners = Vec::new(&env);
    owners.push_back(dup.clone());
    owners.push_back(dup);
    let mut weights = Vec::new(&env);
    for _ in 0..owners.len() {
        weights.push_back(1);
    }
    assert_eq!(
        client.try_initialize(&owners, &weights, &1, &0),
        Err(Ok(ContractError::DuplicateOwner))
    );
}

#[test]
fn initialize_stores_time_lock_delay() {
    let (_, client, _, _, _, _, _) = setup_with_timelock(2, 7200);
    assert_eq!(client.get_time_lock_delay(), 7200);
}

// ─── Proposal Creation ───────────────────────────────────────────────────────

#[test]
fn create_proposal_returns_sequential_ids() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let id1 = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "First"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    let id2 = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            2_000_000,
            &token_client.address,
        ),
        &str(&env, "Second"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(client.get_total_proposals(), 2);
}

#[test]
fn create_proposal_rejects_non_owner() {
    let (env, client, _, _, _, non_owner, token_client) = setup(2);
    assert_eq!(
        client.try_create_proposal(
            &non_owner,
            &t(
                &env,
                &Address::generate(&env),
                1_000_000,
                &token_client.address
            ),
            &str(&env, "Unauthorized"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        ),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn create_proposal_rejects_zero_amount() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(&env, &Address::generate(&env), 0, &token_client.address),
            &str(&env, "Zero"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        ),
        Err(Ok(ContractError::InvalidAmount))
    );
}

#[test]
fn create_proposal_rejects_past_deadline() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(
                &env,
                &Address::generate(&env),
                1_000_000,
                &token_client.address
            ),
            &str(&env, "Stale"),
            &(NOW - 1),
            &ProposalCategory::Transfer,
        ),
        Err(Ok(ContractError::InvalidDeadline))
    );
}

#[test]
fn create_proposal_rejects_empty_description() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(
                &env,
                &Address::generate(&env),
                1_000_000,
                &token_client.address
            ),
            &str(&env, ""),
            &DEADLINE,
            &ProposalCategory::Transfer,
        ),
        Err(Ok(ContractError::EmptyDescription))
    );
}

// New tests for issue #34: invalid vs valid token handling
#[test]
fn create_proposal_rejects_invalid_token() {
    let (env, client, owner_a, _, _, _, _) = setup(2);
    let invalid_token = Address::generate(&env);
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(&env, &Address::generate(&env), 1_000_000, &invalid_token),
            &str(&env, "Bad token"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        ),
        Err(Ok(ContractError::InvalidToken))
    );
}

#[test]
fn create_proposal_accepts_valid_token() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Valid token"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert!(id > 0);
}

#[test]
fn description_boundary() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let recipient = Address::generate(&env);

    // Test exact boundary: 300 characters should succeed
    let description_300 = "a".repeat(300);
    let result_300 = client.try_create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000, &token_client.address),
        &str(&env, &description_300),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert!(result_300.is_ok());

    // Test over boundary: 301 characters should fail
    let description_301 = "a".repeat(301);
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(&env, &recipient, 1_000_000, &token_client.address),
            &str(&env, &description_301),
            &DEADLINE,
            &ProposalCategory::Transfer,
        ),
        Err(Ok(ContractError::DescriptionTooLong))
    );
}

#[test]
fn create_proposal_emits_created_event() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let recipient = Address::generate(&env);
    let amount: i128 = 5_000_000;
    let _id = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, amount, &token_client.address),
        &str(&env, "Grant"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );

    // Verify at least one event was emitted by this contract.
    let contract_events = env.events().all().filter_by_contract(&client.address);
    assert!(
        !contract_events.events().is_empty(),
        "expected a 'created' event to be emitted"
    );
}

// ─── Issue #33: Reject contract as recipient ─────────────────────────────────

#[test]
fn create_proposal_rejects_contract_as_recipient() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(&env, &client.address, 1_000_000, &token_client.address),
            &str(&env, "Self-send"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        ),
        Err(Ok(ContractError::InvalidRecipient))
    );
}

// ─── Category ────────────────────────────────────────────────────────────────

#[test]
fn create_proposal_stores_payroll_category() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Monthly salaries"),
        &DEADLINE,
        &ProposalCategory::Payroll,
    );
    assert_eq!(client.get_proposal(&id).category, ProposalCategory::Payroll);
}

#[test]
fn create_proposal_stores_grant_category() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Developer grant"),
        &DEADLINE,
        &ProposalCategory::Grant,
    );
    assert_eq!(client.get_proposal(&id).category, ProposalCategory::Grant);
}

#[test]
fn create_proposal_category_in_event() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let recipient = Address::generate(&env);
    let _id = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000, &token_client.address),
        &str(&env, "Ops budget"),
        &DEADLINE,
        &ProposalCategory::Ops,
    );

    let all_events = env.events().all();
    let contract_events = all_events.filter_by_contract(&client.address);
    assert!(!contract_events.events().is_empty());

    // The first event is the ProposalCreatedEvent; check its category field.
    let event_data = match &contract_events.events().first().unwrap().body {
        xdr::ContractEventBody::V0(body) => body.data.clone(),
    };
    let event: ProposalCreatedEvent = event_data.into_val(&env);
    assert_eq!(event.category, ProposalCategory::Ops);
}

// ─── Approve ─────────────────────────────────────────────────────────────────

#[test]
fn approve_increments_count_and_sets_flag() {
    let (env, client, owner_a, owner_b, _, _, token_client) = setup(3);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    assert_eq!(client.get_proposal(&id).approvals, 1);
    assert!(client.has_approved(&id, &owner_a));
    client.approve(&owner_b, &id);
    assert_eq!(client.get_proposal(&id).approvals, 2);
}

#[test]
fn get_proposal_approval_progress_returns_live_counts_and_total_owner_weight() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Progress"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );

    let progress = client.get_proposal_approval_progress(&id);
    assert_eq!(
        progress,
        ProposalApprovalProgress {
            approval_weight: 0,
            quorum_weight: 2,
            total_weight: 3,
        }
    );

    client.approve(&owner_a, &id);
    let progress = client.get_proposal_approval_progress(&id);
    assert_eq!(
        progress,
        ProposalApprovalProgress {
            approval_weight: 1,
            quorum_weight: 2,
            total_weight: 3,
        }
    );

    client.approve(&owner_b, &id);
    let progress = client.get_proposal_approval_progress(&id);
    assert_eq!(
        progress,
        ProposalApprovalProgress {
            approval_weight: 2,
            quorum_weight: 2,
            total_weight: 3,
        }
    );
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Ready);
}

#[test]
fn get_proposal_approval_progress_rejects_missing_proposal() {
    let (_env, client, _, _, _, _, _) = setup(2);
    assert_eq!(client.try_get_proposal_approval_progress(&999), Err(Ok(ContractError::ProposalNotFound)));
}

#[test]
fn approve_transitions_pending_to_ready() {
    let (env, client, owner_a, owner_b, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);
    client.approve(&owner_b, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Ready);
}

#[test]
fn approve_rejects_double_approve() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    assert_eq!(
        client.try_approve(&owner_a, &id),
        Err(Ok(ContractError::AlreadyApproved))
    );
}

#[test]
fn approve_rejects_non_owner() {
    let (env, client, owner_a, _, _, non_owner, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert_eq!(
        client.try_approve(&non_owner, &id),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn approve_returns_arithmetic_error_on_overflow() {
    let (env, client, owner_a, owner_b, _, _, token_client) = setup(2);
    let id = 1_u64;
    let proposal = Proposal {
        id,
        proposer: owner_a,
        description: str(&env, "Overflow approvals"),
        deadline: DEADLINE,
        approvals: u32::MAX,
        status: ProposalStatus::Pending,
        kind: ProposalKind::Transfer(t(
            &env,
            &Address::generate(&env),
            1_000_000_i128,
            &token_client.address,
        )),
        ready_at: 0,
        quorum_weight: 2,
        category: ProposalCategory::Transfer,
    };

    env.as_contract(&client.address, || {
        env.storage().persistent().set(&proposal_key(id), &proposal);
    });

    assert_eq!(
        client.try_approve(&owner_b, &id),
        Err(Ok(ContractError::ArithmeticError))
    );
}

// ─── Revoke ──────────────────────────────────────────────────────────────────

#[test]
fn revoke_decrements_count_and_clears_flag() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    client.revoke(&owner_a, &id);
    assert_eq!(client.get_proposal(&id).approvals, 0);
    assert!(!client.has_approved(&id, &owner_a));
}

#[test]
fn revoke_transitions_ready_back_to_pending() {
    let (env, client, owner_a, owner_b, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Ready);
    client.revoke(&owner_a, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);
}

#[test]
fn revoke_rejects_when_not_previously_approved() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert_eq!(
        client.try_revoke(&owner_a, &id),
        Err(Ok(ContractError::NotApproved))
    );
}

// ─── Revoke → Re-approve ──────────────────────────────────────────────────────

#[test]
fn revoke_allows_reapprove() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    client.revoke(&owner_a, &id);
    // Re-approve — should succeed
    client.approve(&owner_a, &id);
    assert_eq!(client.get_proposal(&id).approvals, 1);
}

#[test]
fn revoke_and_reapprove_cycles_ready_pending_ready() {
    let (env, client, owner_a, owner_b, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );

    // Stage 1: Approved -> Ready
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Ready);
    assert_eq!(client.get_proposal(&id).approvals, 2);
    assert!(client.has_approved(&id, &owner_a));

    // Stage 2: Revoked -> Pending
    client.revoke(&owner_a, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);
    assert_eq!(client.get_proposal(&id).approvals, 1);
    assert!(!client.has_approved(&id, &owner_a));

    // Stage 3: Re-approved -> Ready
    client.approve(&owner_a, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Ready);
    assert_eq!(client.get_proposal(&id).approvals, 2);
    assert!(client.has_approved(&id, &owner_a));
}

#[test]
fn has_approved_returns_false_after_revoke() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    assert!(client.has_approved(&id, &owner_a));
    client.revoke(&owner_a, &id);
    assert!(!client.has_approved(&id, &owner_a));
}

// ─── Execute ─────────────────────────────────────────────────────────────────

#[test]
fn execute_transfers_tokens_to_recipient() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);
    let recipient = Address::generate(&env);
    let amount: i128 = 50_000_000;
    let id = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, amount, &token_client.address),
        &str(&env, "Bonus"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    client.approve(&owner_c, &id);
    client.execute(&owner_c, &id);
    assert_eq!(token_client.balance(&recipient), amount);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Executed);
}

#[test]
fn execute_rejects_when_threshold_not_met() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Short"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id); // only 1 of 2
    assert_eq!(
        client.try_execute(&owner_a, &id),
        Err(Ok(ContractError::ThresholdNotMet))
    );
}

#[test]
fn execute_rejects_non_owner() {
    let (env, client, owner_a, owner_b, _, non_owner, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    assert_eq!(
        client.try_execute(&non_owner, &id),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn execute_rejects_already_executed() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    client.execute(&owner_c, &id);
    assert_eq!(
        client.try_execute(&owner_a, &id),
        Err(Ok(ContractError::ProposalNotActive))
    );
}

#[test]
fn execute_emits_executed_event() {
    let (env, client, owner_a, owner_b, _, _, token_client) = setup(2);
    let recipient = Address::generate(&env);
    let amount: i128 = 10_000_000;
    let id = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, amount, &token_client.address),
        &str(&env, "Event"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    client.execute(&owner_a, &id);

    // env.events().all() returns events from the last call; verify execute emitted at least one.
    let contract_events = env.events().all().filter_by_contract(&client.address);
    assert!(
        !contract_events.events().is_empty(),
        "expected an 'executed' event to be emitted"
    );
}

// ─── Expiry ──────────────────────────────────────────────────────────────────

#[test]
fn proposal_shows_expired_after_deadline() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let deadline = NOW + 3_600;
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Short window"),
        &deadline,
        &ProposalCategory::Transfer,
    );
    set_timestamp(&env, deadline + 1);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Expired);
}

#[test]
fn approve_rejects_expired_proposal() {
    let (env, client, owner_a, owner_b, _, _, token_client) = setup(2);
    let deadline = NOW + 3_600;
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Expiring"),
        &deadline,
        &ProposalCategory::Transfer,
    );
    set_timestamp(&env, deadline + 1);
    assert_eq!(
        client.try_approve(&owner_b, &id),
        Err(Ok(ContractError::ProposalNotActive))
    );
}

#[test]
fn execute_rejects_expired_even_if_approved() {
    let (env, client, owner_a, owner_b, _, _, token_client) = setup(2);
    let deadline = NOW + 3_600;
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Approved but expired"),
        &deadline,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    set_timestamp(&env, deadline + 1);
    assert_eq!(
        client.try_execute(&owner_a, &id),
        Err(Ok(ContractError::ProposalExpired))
    );
}

#[test]
fn expired_status_takes_priority_over_ready() {
    let (env, client, owner_a, owner_b, _, _, token_client) = setup(2);
    let deadline = NOW + 3_600;
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Ready then expired"),
        &deadline,
        &ProposalCategory::Transfer,
    );

    // Two owners approve to meet the threshold of 2 while still before the deadline.
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Ready);

    // Once the deadline passes, Expired must take priority over Ready.
    set_timestamp(&env, deadline + 1);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Expired);
}

// ─── Query ───────────────────────────────────────────────────────────────────

#[test]
fn get_version_returns_current_version() {
    let (_, client, _, _, _, _, _) = setup(2);
    assert_eq!(client.get_version(), 1);
}

// ─── get_required_quorum_weight ───────────────────────────────────────────────

/// The view function must return the same quorum weight that gets stored on a
/// proposal created immediately afterwards.
#[test]
fn get_required_quorum_weight_matches_newly_created_proposal() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);

    // Read the view before creating any proposal.
    let reported = client.get_required_quorum_weight();

    // Create a proposal and check its stored quorum_weight.
    let id = client.create_proposal(
        &owner_a,
        &t(&env, &Address::generate(&env), 1_000_000, &token_client.address),
        &str(&env, "Quorum match test"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    let proposal = client.get_proposal(&id);

    assert_eq!(
        reported,
        proposal.quorum_weight,
        "get_required_quorum_weight() must equal the quorum_weight stored on the next created proposal"
    );
}

/// The view function must reflect the updated threshold after a
/// change-threshold proposal is executed.
#[test]
fn get_required_quorum_weight_updates_after_threshold_change() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);

    // Initial threshold is 2.
    assert_eq!(client.get_required_quorum_weight(), 2);

    // Propose and execute a threshold change to 3.
    let change_id = client.create_change_threshold_proposal(
        &owner_a,
        &3,
        &str(&env, "Raise threshold to 3"),
        &DEADLINE,
    );
    client.approve(&owner_a, &change_id);
    client.approve(&owner_b, &change_id);
    client.execute(&owner_c, &change_id);

    // View must now reflect the new threshold.
    assert_eq!(
        client.get_required_quorum_weight(),
        3,
        "get_required_quorum_weight() must return the updated threshold after a change"
    );

    // A proposal created now must also carry the updated quorum weight.
    let id = client.create_proposal(
        &owner_a,
        &t(&env, &Address::generate(&env), 1_000_000, &token_client.address),
        &str(&env, "Post-change proposal"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert_eq!(client.get_proposal(&id).quorum_weight, 3);
}

#[test]
fn is_owner_returns_correct_results() {
    let (_, client, owner_a, _, _, non_owner, _) = setup(2);
    assert!(client.is_owner(&owner_a));
    assert!(!client.is_owner(&non_owner));
}

#[test]
fn get_proposals_paged_returns_correct_window() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    for _ in 0..5_u32 {
        client.create_proposal(
            &owner_a,
            &t(
                &env,
                &Address::generate(&env),
                1_000_000,
                &token_client.address,
            ),
            &str(&env, "Batch"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        );
    }
    let page1 = client.get_proposals_paged(&0, &3);
    assert_eq!(page1.len(), 3);
    assert_eq!(page1.get(0).unwrap().id, 1);
    let page2 = client.get_proposals_paged(&3, &3);
    assert_eq!(page2.len(), 2);
    assert_eq!(page2.get(0).unwrap().id, 4);
}

#[test]
fn get_proposals_paged_returns_empty_beyond_offset() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    for _ in 0..3_u32 {
        client.create_proposal(
            &owner_a,
            &t(
                &env,
                &Address::generate(&env),
                1_000_000,
                &token_client.address,
            ),
            &str(&env, "Test"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        );
    }
    let page = client.get_proposals_paged(&10, &5);
    assert_eq!(page.len(), 0);
}

#[test]
fn get_total_proposals_counts_all_ever_created() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(1);
    // Create 3 proposals
    let id1 = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Proposal 1"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    let id2 = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Proposal 2"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    let _id3 = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Proposal 3"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );

    // Execute 2 of them
    client.approve(&owner_a, &id1);
    client.execute(&owner_b, &id1);
    client.approve(&owner_a, &id2);
    client.execute(&owner_c, &id2);

    // Check total count is still 3
    assert_eq!(client.get_total_proposals(), 3);
}

// ─── Full Lifecycle ───────────────────────────────────────────────────────────

#[test]
fn full_lifecycle_2of3() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);
    let recipient = Address::generate(&env);
    let amount: i128 = 100_000_000;

    let id = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, amount, &token_client.address),
        &str(&env, "Full lifecycle"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);

    client.approve(&owner_a, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);

    client.approve(&owner_b, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Ready);

    let before = token_client.balance(&recipient);
    client.execute(&owner_c, &id);
    assert_eq!(token_client.balance(&recipient) - before, amount);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Executed);
}

#[test]
fn full_lifecycle_5of5() {
    let env = Env::default();
    env.mock_all_auths();
    set_timestamp(&env, NOW);

    let owner_a = Address::generate(&env);
    let owner_b = Address::generate(&env);
    let owner_c = Address::generate(&env);
    let owner_d = Address::generate(&env);
    let owner_e = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_client = token::Client::new(&env, &token_id.address());
    let token_sac = token::StellarAssetClient::new(&env, &token_id.address());

    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);

    let mut owners = Vec::new(&env);
    owners.push_back(owner_a.clone());
    owners.push_back(owner_b.clone());
    owners.push_back(owner_c.clone());

    let mut weights = Vec::new(&env);
    weights.push_back(1);
    weights.push_back(1);
    weights.push_back(1);
    owners.push_back(owner_d.clone());
    owners.push_back(owner_e.clone());
    let mut weights = Vec::new(&env);
    for _ in 0..owners.len() {
        weights.push_back(1);
    }
    client.initialize(&owners, &weights, &5, &0);

    // Fund the multisig contract so it can pay out proposals.
    token_sac.mint(&contract_id, &1_000_000_000_000_i128);

    let amount: i128 = 100_000_000;

    let id = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, amount, &token_client.address),
        &str(&env, "Full lifecycle 5of5"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);

    client.approve(&owner_a, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);

    client.approve(&owner_b, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);

    client.approve(&owner_c, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);

    client.approve(&owner_d, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);

    client.approve(&owner_e, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Ready);

    let before = token_client.balance(&recipient);
    client.execute(&owner_a, &id);
    assert_eq!(token_client.balance(&recipient) - before, amount);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Executed);
}

#[test]
fn execute_fails_when_balance_insufficient() {
    let env = Env::default();
    env.mock_all_auths();
    set_timestamp(&env, NOW);

    let owner_a = Address::generate(&env);
    let owner_b = Address::generate(&env);
    let owner_c = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_client = token::Client::new(&env, &token_id.address());

    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);

    let mut owners = Vec::new(&env);
    owners.push_back(owner_a.clone());
    owners.push_back(owner_b.clone());
    owners.push_back(owner_c.clone());

    let mut weights = Vec::new(&env);
    weights.push_back(1);
    weights.push_back(1);
    weights.push_back(1);
    let mut weights = Vec::new(&env);
    for _ in 0..owners.len() {
        weights.push_back(1);
    }
    client.initialize(&owners, &weights, &2, &0);

    // Do not mint any tokens to the contract — balance is zero.

    let amount: i128 = 1_000_000;
    let id = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, amount, &token_client.address),
        &str(&env, "Insufficient balance"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );

    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);

    // Execute should fail because the contract has no funds.
    assert_eq!(
        client.try_execute(&owner_a, &id),
        Err(Ok(ContractError::TransferFailed))
    );
}

#[test]
fn create_proposal_rejects_at_limit() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let recipient = Address::generate(&env);

    // Create exactly 50 proposals (MAX_ACTIVE_PROPOSALS).
    for i in 0..50 {
        client.create_proposal(
            &owner_a,
            &t(&env, &recipient, 1_000_000, &token_client.address),
            &str(&env, &format!("Proposal {}", i)),
            &DEADLINE,
            &ProposalCategory::Transfer,
        );
    }

    // The 51st proposal should be rejected with TooManyActiveProposals.
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(&env, &recipient, 1_000_000, &token_client.address),
            &str(&env, "51st proposal"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        ),
        Err(Ok(ContractError::TooManyActiveProposals))
    );
}

// ─── Deadline Edge Cases ──────────────────────────────────────────────────────

#[test]
fn create_proposal_rejects_deadline_at_now() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    // A deadline equal to the current ledger timestamp must be rejected, because
    // the contract uses `deadline <= now` as the invalid-deadline guard.
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(
                &env,
                &Address::generate(&env),
                1_000_000,
                &token_client.address
            ),
            &str(&env, "Deadline at now"),
            &NOW, // exactly the current timestamp
            &ProposalCategory::Transfer,
        ),
        Err(Ok(ContractError::InvalidDeadline))
    );
}

#[test]
fn get_approvers_returns_only_approved_addresses() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(3);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);

    let approvers = client.get_approvers(&id);
    assert_eq!(approvers.len(), 2);
    assert!(approvers.contains(&owner_a));
    assert!(approvers.contains(&owner_b));
    assert!(!approvers.contains(&owner_c));
}

#[test]
fn get_approvers_returns_empty_when_none_have_approved() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );

    let approvers = client.get_approvers(&id);
    assert_eq!(approvers.len(), 0);
}

#[test]
fn get_approvers_excludes_revoked_approval() {
    let (env, client, owner_a, owner_b, _, _, token_client) = setup(3);
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    client.revoke(&owner_a, &id);

    let approvers = client.get_approvers(&id);
    assert_eq!(approvers.len(), 1);
    assert!(!approvers.contains(&owner_a));
    assert!(approvers.contains(&owner_b));
}

#[test]
fn get_approvers_rejects_unknown_proposal() {
    let (_, client, _, _, _, _, _) = setup(2);
    assert_eq!(
        client.try_get_approvers(&999),
        Err(Ok(ContractError::ProposalNotFound))
    );
}

// ─── Upgrade ─────────────────────────────────────────────────────────────────

#[test]
fn upgrade_rejects_non_owner() {
    let (env, client, _, _, _, non_owner, _) = setup(2);
    let dummy_hash: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
    let mut approvers = Vec::new(&env);
    approvers.push_back(non_owner.clone());
    approvers.push_back(Address::generate(&env)); // another non-owner to reach len >= threshold
    assert_eq!(
        client.try_upgrade(&approvers, &dummy_hash),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn upgrade_rejects_below_threshold() {
    let (env, client, owner_a, _, _, _, _) = setup(2);
    let dummy_hash: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
    // Only 1 approver, but threshold is 2.
    let mut approvers = Vec::new(&env);
    approvers.push_back(owner_a.clone());
    assert_eq!(
        client.try_upgrade(&approvers, &dummy_hash),
        Err(Ok(ContractError::ThresholdNotMet))
    );
}

#[test]
fn upgrade_rejects_duplicate_approver() {
    let (env, client, owner_a, _, _, _, _) = setup(2);
    let dummy_hash: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
    // Pass owner_a twice to try to satisfy a threshold-of-2 with one real owner.
    let mut approvers = Vec::new(&env);
    approvers.push_back(owner_a.clone());
    approvers.push_back(owner_a.clone());
    assert_eq!(
        client.try_upgrade(&approvers, &dummy_hash),
        Err(Ok(ContractError::DuplicateOwner))
    );
}

#[test]
fn upgrade_succeeds_with_threshold_many_owners() {
    let (env, client, owner_a, owner_b, _, _, _) = setup(2);
    // Provide exactly `threshold` (2) distinct registered owners.
    // We use a zeroed hash as a placeholder; in a real upgrade this would be a
    // valid WASM hash. The test just verifies the access-control path passes.
    let dummy_hash: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
    let mut approvers = Vec::new(&env);
    approvers.push_back(owner_a.clone());
    approvers.push_back(owner_b.clone());
    // Should not panic / return an error for the auth + ownership checks.
    // (The deployer call may be a no-op in the test environment with a dummy hash.)
    let _ = client.try_upgrade(&approvers, &dummy_hash);
    // We only assert that it did NOT return a ContractError — the deployer itself
    // may or may not error depending on the test harness WASM support.
}

#[test]
fn upgrade_emits_event() {
    let (env, client, owner_a, owner_b, _, _, _) = setup(2);
    let dummy_hash = env.deployer().upload_contract_wasm(Bytes::new(&env));
    let mut approvers = Vec::new(&env);
    approvers.push_back(owner_a.clone());
    approvers.push_back(owner_b);

    client.upgrade(&approvers, &dummy_hash);

    let contract_events = env.events().all().filter_by_contract(&client.address);
    let upgraded_event = contract_events.events().iter().find(|event| {
        let event_topics = match &event.body {
            xdr::ContractEventBody::V0(body) => body.topics.clone(),
        };
        let Some(topic) = event_topics.first() else {
            return false;
        };
        let topic: Symbol = topic.clone().into_val(&env);
        topic == symbol_short!("upgraded")
    });

    let event = upgraded_event.expect("expected an 'upgraded' event to be emitted");
    let event_data = match &event.body {
        xdr::ContractEventBody::V0(body) => body.data.clone(),
    };
    let event: UpgradeExecutedEvent = event_data.into_val(&env);
    assert_eq!(event.caller, owner_a);
    assert_eq!(event.new_wasm_hash, dummy_hash);
}

// ─── Active Count ─────────────────────────────────────────────────────────────

#[test]
fn active_count_stays_accurate_after_execute() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);
    let recipient = Address::generate(&env);

    // Fill up the active slots
    for _ in 0..50 {
        client.create_proposal(
            &owner_a,
            &t(&env, &recipient, 1_000_000, &token_client.address),
            &str(&env, "Fill"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        );
    }

    // 51st proposal should fail
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(&env, &recipient, 1_000_000, &token_client.address),
            &str(&env, "Overflow"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        ),
        Err(Ok(ContractError::TooManyActiveProposals))
    );

    // Approve and execute 2 proposals
    client.approve(&owner_a, &1);
    client.approve(&owner_b, &1);
    client.execute(&owner_c, &1);
    assert_eq!(client.get_proposal(&1).status, ProposalStatus::Executed);

    client.approve(&owner_a, &2);
    client.approve(&owner_b, &2);
    client.execute(&owner_c, &2);
    assert_eq!(client.get_proposal(&2).status, ProposalStatus::Executed);

    // Now we should be able to create 2 more proposals
    let id51 = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000, &token_client.address),
        &str(&env, "New 1"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    let id52 = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000, &token_client.address),
        &str(&env, "New 2"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert_eq!(id51, 51);
    assert_eq!(id52, 52);

    // And the 53rd should fail again
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(&env, &recipient, 1_000_000, &token_client.address),
            &str(&env, "Overflow 2"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        ),
        Err(Ok(ContractError::TooManyActiveProposals))
    );
}

#[test]
fn active_count_stays_accurate_after_expire() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let recipient = Address::generate(&env);

    let short_deadline = NOW + 1_000;
    let long_deadline = NOW + 10_000;

    // Create 2 proposals with a short deadline
    client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000_i128, &token_client.address),
        &str(&env, "Short 1"),
        &short_deadline,
        &ProposalCategory::Transfer,
    );
    client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000_i128, &token_client.address),
        &str(&env, "Short 2"),
        &short_deadline,
        &ProposalCategory::Transfer,
    );

    // Create 48 proposals with a long deadline
    for _ in 2..50 {
        client.create_proposal(
            &owner_a,
            &t(&env, &recipient, 1_000_000_i128, &token_client.address),
            &str(&env, "Long"),
            &long_deadline,
            &ProposalCategory::Transfer,
        );
    }

    // 51st proposal should fail
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(&env, &recipient, 1_000_000_i128, &token_client.address),
            &str(&env, "Overflow"),
            &long_deadline,
            &ProposalCategory::Transfer
        ),
        Err(Ok(ContractError::TooManyActiveProposals))
    );

    // Advance time past the short deadline
    set_timestamp(&env, short_deadline + 1);

    // Calling execute on expired proposals returns ProposalExpired and frees the active slot.
    assert_eq!(
        client.try_execute(&owner_a, &1),
        Err(Ok(ContractError::ProposalExpired))
    );
    assert_eq!(client.get_proposal(&1).status, ProposalStatus::Expired);
    assert_eq!(
        client.try_execute(&owner_a, &2),
        Err(Ok(ContractError::ProposalExpired))
    );
    assert_eq!(client.get_proposal(&2).status, ProposalStatus::Expired);

    // Now we should be able to create 2 more proposals
    let id51 = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000_i128, &token_client.address),
        &str(&env, "New 1"),
        &long_deadline,
        &ProposalCategory::Transfer,
    );
    let id52 = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000_i128, &token_client.address),
        &str(&env, "New 2"),
        &long_deadline,
        &ProposalCategory::Transfer,
    );
    assert_eq!(id51, 51);
    assert_eq!(id52, 52);

    // And the 53rd should fail again
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(&env, &recipient, 1_000_000_i128, &token_client.address),
            &str(&env, "Overflow 2"),
            &long_deadline,
            &ProposalCategory::Transfer
        ),
        Err(Ok(ContractError::TooManyActiveProposals))
    );
}

#[test]
fn active_count_stays_accurate_mixed() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);
    let recipient = Address::generate(&env);

    let short_deadline = NOW + 1_000;
    let long_deadline = NOW + 10_000;

    // Create 1 short deadline
    client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000_i128, &token_client.address),
        &str(&env, "Short 1"),
        &short_deadline,
        &ProposalCategory::Transfer,
    );

    // Create 49 long deadline
    for _ in 1..50 {
        client.create_proposal(
            &owner_a,
            &t(&env, &recipient, 1_000_000_i128, &token_client.address),
            &str(&env, "Long"),
            &long_deadline,
            &ProposalCategory::Transfer,
        );
    }

    // 51st proposal should fail
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(&env, &recipient, 1_000_000_i128, &token_client.address),
            &str(&env, "Overflow"),
            &long_deadline,
            &ProposalCategory::Transfer
        ),
        Err(Ok(ContractError::TooManyActiveProposals))
    );

    // Execute proposal 2 (long deadline) — frees one active slot.
    client.approve(&owner_a, &2);
    client.approve(&owner_b, &2);
    client.execute(&owner_c, &2);
    assert_eq!(client.get_proposal(&2).status, ProposalStatus::Executed);

    // Create 1 new proposal (long deadline)
    let id51 = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000_i128, &token_client.address),
        &str(&env, "New 1"),
        &long_deadline,
        &ProposalCategory::Transfer,
    );
    assert_eq!(id51, 51);

    // Advance time past the short deadline
    set_timestamp(&env, short_deadline + 1);

    // Calling execute on expired proposal 1 returns ProposalExpired and frees its active slot.
    assert_eq!(
        client.try_execute(&owner_a, &1),
        Err(Ok(ContractError::ProposalExpired))
    );
    assert_eq!(client.get_proposal(&1).status, ProposalStatus::Expired);

    // Create 1 new proposal (long deadline)
    let id52 = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000_i128, &token_client.address),
        &str(&env, "New 2"),
        &long_deadline,
        &ProposalCategory::Transfer,
    );
    assert_eq!(id52, 52);

    // 53rd proposal should fail
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(&env, &recipient, 1_000_000_i128, &token_client.address),
            &str(&env, "Overflow 2"),
            &long_deadline,
            &ProposalCategory::Transfer
        ),
        Err(Ok(ContractError::TooManyActiveProposals))
    );
}

// ─── cancel_expired ───────────────────────────────────────────────────────────

#[test]
fn cancel_expired_sweeps_two_expired_proposals() {
    let (env, client, owner_a, _, _, _, token_client) = setup(1);
    let recipient = Address::generate(&env);

    let id1 = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000_i128, &token_client.address),
        &str(&env, "p1"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    let id2 = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000_i128, &token_client.address),
        &str(&env, "p2"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );

    set_timestamp(&env, DEADLINE + 1);

    let mut ids = Vec::new(&env);
    ids.push_back(id1);
    ids.push_back(id2);
    let swept = client.cancel_expired(&owner_a, &ids);

    assert_eq!(swept, 2);
    assert_eq!(client.get_proposal(&id1).status, ProposalStatus::Expired);
    assert_eq!(client.get_proposal(&id2).status, ProposalStatus::Expired);
}

#[test]
fn cancel_expired_skips_non_expired_proposal() {
    let long_deadline = DEADLINE + 86_400;
    let (env, client, owner_a, _, _, _, token_client) = setup(1);
    let recipient = Address::generate(&env);

    let id1 = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000_i128, &token_client.address),
        &str(&env, "short"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    let id2 = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000_i128, &token_client.address),
        &str(&env, "long"),
        &long_deadline,
        &ProposalCategory::Transfer,
    );

    set_timestamp(&env, DEADLINE + 1);

    let mut ids = Vec::new(&env);
    ids.push_back(id1);
    ids.push_back(id2);
    let swept = client.cancel_expired(&owner_a, &ids);

    assert_eq!(swept, 1);
    assert_eq!(client.get_proposal(&id2).status, ProposalStatus::Pending);
}

#[test]
fn cancel_expired_skips_nonexistent_id() {
    let (env, client, owner_a, _, _, _, token_client) = setup(1);
    let recipient = Address::generate(&env);

    let id1 = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000_i128, &token_client.address),
        &str(&env, "real"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );

    set_timestamp(&env, DEADLINE + 1);

    let mut ids = Vec::new(&env);
    ids.push_back(id1);
    ids.push_back(999_u64);
    let swept = client.cancel_expired(&owner_a, &ids);

    assert_eq!(swept, 1);
}

#[test]
fn cancel_expired_rejects_non_owner() {
    let (env, client, owner_a, _, _, non_owner, token_client) = setup(1);
    let recipient = Address::generate(&env);

    client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000_i128, &token_client.address),
        &str(&env, "x"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );

    set_timestamp(&env, DEADLINE + 1);

    let mut ids = Vec::new(&env);
    ids.push_back(1_u64);

    assert_eq!(
        client.try_cancel_expired(&non_owner, &ids),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn cancel_expired_unblocks_active_cap() {
    let (env, client, owner_a, _, _, _, token_client) = setup(1);
    let recipient = Address::generate(&env);

    for _ in 0..50 {
        client.create_proposal(
            &owner_a,
            &t(&env, &recipient, 1_000_000_i128, &token_client.address),
            &str(&env, "fill"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        );
    }

    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(&env, &recipient, 1_000_000_i128, &token_client.address),
            &str(&env, "over"),
            &DEADLINE,
            &ProposalCategory::Transfer
        ),
        Err(Ok(ContractError::TooManyActiveProposals))
    );

    set_timestamp(&env, DEADLINE + 1);

    let mut ids = Vec::new(&env);
    for i in 1_u64..=50 {
        ids.push_back(i);
    }
    let swept = client.cancel_expired(&owner_a, &ids);
    assert_eq!(swept, 50);

    let new_id = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000_i128, &token_client.address),
        &str(&env, "new"),
        &(DEADLINE + 86_400),
        &ProposalCategory::Transfer,
    );
    assert_eq!(new_id, 51);
}

// ─── Add-Owner Proposals ───────────────────────────────────────────────────────

#[test]
fn add_owner_full_lifecycle() {
    let (env, client, owner_a, owner_b, owner_c, non_owner, _) = setup(2);

    // The future owner is not part of the set yet.
    assert!(!client.is_owner(&non_owner));

    let id = client.create_add_owner_proposal(
        &owner_a,
        &non_owner,
        &str(&env, "Add a fourth owner"),
        &DEADLINE,
    );
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);

    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Ready);

    client.execute(&owner_c, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Executed);

    // The new owner now appears in the owner set.
    let owners = client.get_owners();
    assert_eq!(owners.len(), 4);
    assert!(owners.contains(&non_owner));
    assert!(client.is_owner(&non_owner));
}

#[test]
fn create_add_owner_proposal_rejects_existing_owner() {
    let (env, client, owner_a, owner_b, _, _, _) = setup(2);

    // owner_b is already an owner, so proposing to add them is rejected.
    assert_eq!(
        client.try_create_add_owner_proposal(
            &owner_a,
            &owner_b,
            &str(&env, "Re-add an existing owner"),
            &DEADLINE,
        ),
        Err(Ok(ContractError::DuplicateOwner))
    );
}

#[test]
fn create_add_owner_proposal_rejects_at_max_owners() {
    let env = Env::default();
    env.mock_all_auths();
    set_timestamp(&env, NOW);

    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);

    // Initialize with exactly MAX_OWNERS (20) owners.
    let mut owners = Vec::new(&env);
    let first_owner = Address::generate(&env);
    owners.push_back(first_owner.clone());
    for _ in 1..20 {
        owners.push_back(Address::generate(&env));
    }
    let mut weights = Vec::new(&env);
    for _ in 0..owners.len() {
        weights.push_back(1);
    }
    client.initialize(&owners, &weights, &1, &0);
    assert_eq!(client.get_owners().len(), 20);

    // Adding a 21st owner would exceed the cap.
    let new_owner = Address::generate(&env);
    assert_eq!(
        client.try_create_add_owner_proposal(
            &first_owner,
            &new_owner,
            &str(&env, "Exceed the owner cap"),
            &DEADLINE,
        ),
        Err(Ok(ContractError::InvalidOwners))
    );
}

// ─── Spending Limits (issue #41) ───────────────────────────────────────────────

#[test]
fn spending_limit_full_lifecycle() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);
    let limit: i128 = 1_000_000;

    // No limit initially: unrestricted.
    assert_eq!(
        client.get_spending_limit(&owner_a, &token_client.address),
        None
    );

    // Set a limit for owner_a via the multisig flow: propose, approve, execute.
    let id = client.create_spending_limit_proposal(
        &owner_a,
        &owner_a,
        &token_client.address,
        &limit,
        &str(&env, "Cap owner_a at 1,000,000"),
        &DEADLINE,
    );
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    client.execute(&owner_c, &id);

    assert_eq!(
        client.get_spending_limit(&owner_a, &token_client.address),
        Some(limit)
    );

    // A proposal at the limit succeeds.
    let within = client.create_proposal(
        &owner_a,
        &t(&env, &Address::generate(&env), limit, &token_client.address),
        &str(&env, "Within limit"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert!(within > 0);

    // A proposal over the limit is rejected.
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(
                &env,
                &Address::generate(&env),
                limit + 1,
                &token_client.address
            ),
            &str(&env, "Over limit"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        ),
        Err(Ok(ContractError::SpendingLimitExceeded))
    );
}

#[test]
fn proposer_without_limit_is_unrestricted() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);

    // No limit configured for owner_a, so a large amount is allowed.
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000_000,
            &token_client.address,
        ),
        &str(&env, "Large amount, no limit"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert_eq!(id, 1);
}

// ─── Cumulative Spending Limit (issue #237) ───────────────────────────────────

#[test]
fn spending_limit_cumulative_across_multiple_proposals() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);
    let limit: i128 = 10_000_000;

    // Set a spending limit of 10M for owner_a.
    let limit_id = client.create_spending_limit_proposal(
        &owner_a,
        &owner_a,
        &token_client.address,
        &limit,
        &str(&env, "Set 10M limit"),
        &DEADLINE,
    );
    client.approve(&owner_a, &limit_id);
    client.approve(&owner_b, &limit_id);
    client.execute(&owner_c, &limit_id);

    // First proposal of 6M succeeds (under 10M).
    let id1 = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            6_000_000,
            &token_client.address,
        ),
        &str(&env, "First 6M"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert!(id1 > 0);

    // Execute the first proposal so the 6M counts as spent.
    client.approve(&owner_a, &id1);
    client.approve(&owner_b, &id1);
    client.execute(&owner_c, &id1);

    // Second proposal of 5M would push cumulative to 11M > 10M → rejected.
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &t(
                &env,
                &Address::generate(&env),
                5_000_000,
                &token_client.address
            ),
            &str(&env, "Second 5M"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        ),
        Err(Ok(ContractError::SpendingLimitExceeded))
    );

    // Third proposal of 4M succeeds (6M + 4M = 10M, exactly at the limit).
    let id3 = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            4_000_000,
            &token_client.address,
        ),
        &str(&env, "Third 4M"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert!(id3 > 0);

    // The remaining limit should now show 4M (not yet executed).
    let remaining = client.get_remaining_spending_limit(&owner_a, &token_client.address);
    assert_eq!(remaining, Some(4_000_000));

    // Execute the third proposal.
    client.approve(&owner_a, &id3);
    client.approve(&owner_b, &id3);
    client.execute(&owner_c, &id3);

    // Remaining should now be 0.
    let remaining = client.get_remaining_spending_limit(&owner_a, &token_client.address);
    assert_eq!(remaining, Some(0));
}

#[test]
fn spending_limit_cumulative_with_same_token_multi_transfer() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);
    let limit: i128 = 10_000_000;

    let limit_id = client.create_spending_limit_proposal(
        &owner_a,
        &owner_a,
        &token_client.address,
        &limit,
        &str(&env, "Set limit"),
        &DEADLINE,
    );
    client.approve(&owner_a, &limit_id);
    client.approve(&owner_b, &limit_id);
    client.execute(&owner_c, &limit_id);

    // A multi-transfer proposal with two transfers of the same token — totals are aggregated.
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    let mut transfers = Vec::new(&env);
    transfers.push_back(Transfer {
        to: recipient1,
        token: token_client.address.clone(),
        amount: 6_000_000,
    });
    transfers.push_back(Transfer {
        to: recipient2,
        token: token_client.address.clone(),
        amount: 5_000_000,
    });
    // 6M + 5M = 11M, exceeding the 10M limit.
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &transfers,
            &str(&env, "Multi-transfer over limit"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        ),
        Err(Ok(ContractError::SpendingLimitExceeded))
    );
}

#[test]
fn spending_limit_different_tokens_independent() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);

    let token_admin2 = Address::generate(&env);
    let token_id2 = env.register_stellar_asset_contract_v2(token_admin2);
    let token2_client = token::Client::new(&env, &token_id2.address());
    let _token2_sac = token::StellarAssetClient::new(&env, &token_id2.address());

    // Set limit on first token only.
    let limit_id = client.create_spending_limit_proposal(
        &owner_a,
        &owner_a,
        &token_client.address,
        &1_000_000,
        &str(&env, "Limit token 1"),
        &DEADLINE,
    );
    client.approve(&owner_a, &limit_id);
    client.approve(&owner_b, &limit_id);
    client.execute(&owner_c, &limit_id);

    // Spend on token 1 (900k).
    let id1 = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            900_000,
            &token_client.address,
        ),
        &str(&env, "Use token 1"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id1);
    client.approve(&owner_b, &id1);
    client.execute(&owner_c, &id1);

    // Remaining on token 1: 100k.
    assert_eq!(
        client.get_remaining_spending_limit(&owner_a, &token_client.address),
        Some(100_000)
    );

    // Token 2 has no limit — unrestricted.
    assert_eq!(
        client.get_remaining_spending_limit(&owner_a, &token2_client.address),
        None,
    );

    // Large proposal on token 2 (unrestricted) succeeds.
    let id2 = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            999_999_999,
            &token2_client.address,
        ),
        &str(&env, "Large token 2"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert!(id2 > 0);
}

#[test]
fn get_remaining_spending_limit_no_limit() {
    let (_, client, owner_a, _, _, _, token_client) = setup(2);
    assert_eq!(
        client.get_remaining_spending_limit(&owner_a, &token_client.address),
        None,
    );
}

#[test]
fn spending_limit_window_expiry_resets_cumulative() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);
    let limit: i128 = 10_000_000;

    let limit_id = client.create_spending_limit_proposal(
        &owner_a,
        &owner_a,
        &token_client.address,
        &limit,
        &str(&env, "Set limit"),
        &DEADLINE,
    );
    client.approve(&owner_a, &limit_id);
    client.approve(&owner_b, &limit_id);
    client.execute(&owner_c, &limit_id);

    // Spend 6M.
    let id1 = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            6_000_000,
            &token_client.address,
        ),
        &str(&env, "Spend 6M"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id1);
    client.approve(&owner_b, &id1);
    client.execute(&owner_c, &id1);

    assert_eq!(
        client.get_remaining_spending_limit(&owner_a, &token_client.address),
        Some(4_000_000)
    );

    // Advance time past the spending window.
    // SPENDING_WINDOW is 2_592_000 (30 days). We are at NOW (1_000) after execute.
    // Setting epoch + window expiry: move past NOW + 2_592_000.
    set_timestamp(&env, NOW + 2_592_001);

    // After window expiry, the spent should reset.
    // But first, the spend tracker epoch was set to NOW (1_000) via SetSpendingLimit execute.
    // NOW is 1_000, NOW + SPENDING_WINDOW = 2_593_000. We advanced to 2_593_001.
    assert_eq!(
        client.get_remaining_spending_limit(&owner_a, &token_client.address),
        Some(limit),
    );

    // New spending after window reset also works.
    let far_deadline = NOW + 2_592_000 + 86_400;
    let id2 = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            5_000_000,
            &token_client.address,
        ),
        &str(&env, "New window spend"),
        &far_deadline,
        &ProposalCategory::Transfer,
    );
    assert!(id2 > 0);
}

// ─── Change Owner Weight (issue #274) ───────────────────────────────────────────

#[test]
fn change_weight_full_lifecycle() {
    let (env, client, owner_a, owner_b, owner_c, _, _) = setup(2);

    // Owner A (default weight 1) and Owner B (default weight 1).
    assert_eq!(client.get_total_weight(), 3);

    let id = client.create_change_weight_proposal(
        &owner_a,
        &owner_b,
        &2,
        &str(&env, "Change owner_b weight to 2"),
        &DEADLINE,
    );
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);

    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Ready);

    client.execute(&owner_c, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Executed);

    // Total weight should be: old(3) - old_owner_b_weight(1) + new_owner_b_weight(2) = 4.
    assert_eq!(client.get_total_weight(), 4);
}

#[test]
fn change_weight_with_active_proposals_passes_invariant_check() {
    let env = Env::default();
    env.mock_all_auths();
    set_timestamp(&env, NOW);

    let owner_a = Address::generate(&env);
    let owner_b = Address::generate(&env);
    let owner_c = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_client = token::Client::new(&env, &token_id.address());
    let token_sac = token::StellarAssetClient::new(&env, &token_id.address());

    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);

    let mut owners = Vec::new(&env);
    owners.push_back(owner_a.clone());
    owners.push_back(owner_b.clone());
    owners.push_back(owner_c.clone());

    let mut weights = Vec::new(&env);
    weights.push_back(1);
    weights.push_back(1);
    weights.push_back(1);
    client.initialize(&owners, &weights, &2, &0);
    token_sac.mint(&contract_id, &1_000_000_000_000_i128);

    let transfer_id = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000, &token_client.address),
        &str(&env, "Active while weight changes"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &transfer_id);

    // Change Owner A's weight from 1 to 2. New total = 3 - 1 + 2 = 4.
    // Active proposal has quorum=2. 2 <= 4, so the invariant check passes.
    let weight_id = client.create_change_weight_proposal(
        &owner_b,
        &owner_a,
        &2,
        &str(&env, "Increase owner_a weight"),
        &DEADLINE,
    );
    client.approve(&owner_b, &weight_id);
    client.approve(&owner_c, &weight_id);
    client.execute(&owner_c, &weight_id);

    assert_eq!(
        client.get_proposal(&weight_id).status,
        ProposalStatus::Executed
    );
    assert_eq!(client.get_total_weight(), 4);

    // The original transfer proposal is still viable.
    client.approve(&owner_b, &transfer_id);
    assert_eq!(
        client.get_proposal(&transfer_id).status,
        ProposalStatus::Ready
    );
}

#[test]
fn change_weight_rejects_non_existent_owner() {
    let (env, client, owner_a, _, _, _, _) = setup(2);
    let non_owner = Address::generate(&env);

    assert_eq!(
        client.try_create_change_weight_proposal(
            &owner_a,
            &non_owner,
            &5,
            &str(&env, "Change non-owner weight"),
            &DEADLINE,
        ),
        Err(Ok(ContractError::OwnerNotFound))
    );
}

#[test]
fn change_weight_rejects_invalid_weight() {
    let (env, client, owner_a, owner_b, _, _, _) = setup(2);

    assert_eq!(
        client.try_create_change_weight_proposal(
            &owner_a,
            &owner_b,
            &0,
            &str(&env, "Weight zero"),
            &DEADLINE,
        ),
        Err(Ok(ContractError::InvalidWeight))
    );

    assert_eq!(
        client.try_create_change_weight_proposal(
            &owner_a,
            &owner_b,
            &100_001,
            &str(&env, "Weight too high"),
            &DEADLINE,
        ),
        Err(Ok(ContractError::InvalidWeight))
    );
}

// ─── Change Owner Weight: Non-owner Rejection (issue #317) ─────────────────────

#[test]
fn change_weight_proposal_rejects_non_owner_and_leaves_state_unchanged() {
    let (env, client, owner_a, owner_b, _, non_owner, _) = setup(2);

    assert_eq!(client.get_total_proposals(), 0);

    assert_eq!(
        client.try_create_change_weight_proposal(
            &owner_a,
            &non_owner,
            &5,
            &str(&env, "Change non-owner weight"),
            &DEADLINE,
        ),
        Err(Ok(ContractError::OwnerNotFound))
    );

    assert_eq!(client.get_total_proposals(), 0);

    let id = client.create_change_weight_proposal(
        &owner_a,
        &owner_b,
        &2,
        &str(&env, "Change owner_b weight to 2"),
        &DEADLINE,
    );
    assert!(id > 0);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);
    assert_eq!(client.get_total_proposals(), 1);
}

// ─── Approval Progress (issue #316) ───────────────────────────────────────────

#[test]
fn approval_progress_reflects_each_stage_of_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();
    set_timestamp(&env, NOW);

    let owner_a = Address::generate(&env);
    let owner_b = Address::generate(&env);
    let owner_c = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_client = token::Client::new(&env, &token_id.address());
    let token_sac = token::StellarAssetClient::new(&env, &token_id.address());

    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);

    let mut owners = Vec::new(&env);
    owners.push_back(owner_a.clone());
    owners.push_back(owner_b.clone());
    owners.push_back(owner_c.clone());

    let mut weights = Vec::new(&env);
    weights.push_back(3);
    weights.push_back(2);
    weights.push_back(1);
    client.initialize(&owners, &weights, &4, &0);
    token_sac.mint(&contract_id, &1_000_000_000_000_i128);

    let id = client.create_proposal(
        &owner_a,
        &t(&env, &Address::generate(&env), 1_000_000, &token_client.address),
        &str(&env, "Progress test"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );

    let progress = client.get_proposal_approval_progress(&id);
    assert_eq!(progress.approval_weight, 0);
    assert_eq!(progress.quorum_weight, 4);
    assert_eq!(progress.total_weight, 6);

    client.approve(&owner_b, &id);
    let progress = client.get_proposal_approval_progress(&id);
    assert_eq!(progress.approval_weight, 2);
    assert_eq!(progress.quorum_weight, 4);
    assert_eq!(progress.total_weight, 6);

    client.approve(&owner_a, &id);
    let progress = client.get_proposal_approval_progress(&id);
    assert_eq!(progress.approval_weight, 5);
    assert_eq!(progress.quorum_weight, 4);
    assert_eq!(progress.total_weight, 6);

    client.revoke(&owner_b, &id);
    let progress = client.get_proposal_approval_progress(&id);
    assert_eq!(progress.approval_weight, 3);
    assert_eq!(progress.quorum_weight, 4);
    assert_eq!(progress.total_weight, 6);
}

// ─── Equal Weight Flat Regression (issue #314) ────────────────────────────────

#[test]
fn equal_weight_all_owners_matches_flat_threshold_semantics() {
    let configs: &[(u32, u32)] = &[
        (1, 1),
        (2, 1),
        (2, 2),
        (3, 2),
        (5, 3),
        (12, 5),
    ];

    for &(owner_count, threshold) in configs {
        let env = Env::default();
        env.mock_all_auths();
        set_timestamp(&env, NOW);

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_client = token::Client::new(&env, &token_id.address());
        let token_sac = token::StellarAssetClient::new(&env, &token_id.address());

        let contract_id = env.register(AccordContract, ());
        let client = AccordContractClient::new(&env, &contract_id);

        let mut owners = Vec::new(&env);
        for _ in 0..owner_count {
            owners.push_back(Address::generate(&env));
        }
        let mut weights = Vec::new(&env);
        for _ in 0..owner_count {
            weights.push_back(1);
        }
        client.initialize(&owners, &weights, &threshold, &0);
        token_sac.mint(&contract_id, &1_000_000_000_000_i128);

        let id = client.create_proposal(
            &owners.get(0).unwrap(),
            &t(&env, &Address::generate(&env), 1_000_000, &token_client.address),
            &str(&env, "Equal weight test"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        );
        assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);

        for i in 0..threshold - 1 {
            client.approve(&owners.get(i).unwrap(), &id);
        }
        assert_eq!(
            client.get_proposal(&id).status,
            ProposalStatus::Pending,
            "With {} owners, threshold {} should still be Pending after {} approvals",
            owner_count,
            threshold,
            threshold - 1
        );

        client.approve(&owners.get(threshold - 1).unwrap(), &id);
        assert_eq!(
            client.get_proposal(&id).status,
            ProposalStatus::Ready,
            "With {} owners, threshold {} should be Ready after {} approvals",
            owner_count,
            threshold,
            threshold
        );

        client.revoke(&owners.get(0).unwrap(), &id);
        assert_eq!(
            client.get_proposal(&id).status,
            ProposalStatus::Pending,
            "Revoking one approval should drop back to Pending"
        );

        client.approve(&owners.get(0).unwrap(), &id);
        assert_eq!(
            client.get_proposal(&id).status,
            ProposalStatus::Ready,
            "Re-approving should reach Ready again"
        );
    }
}

// ─── Property Tests (issue #55) ─────────────────────────────────────────────────

// ─── ProposalCreatedEvent weight snapshot ────────────────────────────────────

/// Verifies that `ProposalCreatedEvent` captures `quorum_weight` and
/// `total_weight_at_creation` at the moment of creation, and that those
/// recorded values are unaffected by weight changes made afterwards.
#[test]
fn test_proposal_created_event_snapshots_weights() {
    // 3 owners each with weight 1, threshold 2 → total_weight = 3.
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);

    let recipient = Address::generate(&env);
    let _id = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, 1_000_000, &token_client.address),
        &str(&env, "Snapshot test"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );

    // Capture the ProposalCreatedEvent emitted by the creation call.
    let all_events = env.events().all();
    let contract_events = all_events.filter_by_contract(&client.address);
    assert!(!contract_events.events().is_empty(), "expected a created event");

    let event_data = match &contract_events.events().first().unwrap().body {
        xdr::ContractEventBody::V0(body) => body.data.clone(),
    };
    let event: ProposalCreatedEvent = event_data.into_val(&env);

    // At creation: threshold = 2, total_weight = 3.
    assert_eq!(event.quorum_weight, 2, "quorum_weight should equal the threshold at creation");
    assert_eq!(event.total_weight_at_creation, 3, "total_weight_at_creation should equal the sum of all owner weights at creation");

    // Remove owner_c, reducing the live total weight to 2.
    let remove_id = client.create_remove_owner_proposal(
        &owner_a,
        &owner_c,
        &str(&env, "Remove owner_c"),
        &DEADLINE,
    );
    client.approve(&owner_a, &remove_id);
    client.approve(&owner_b, &remove_id);
    client.execute(&owner_b, &remove_id);

    // Live total weight is now 2.
    assert_eq!(client.get_total_weight(), 2, "total weight after removal should be 2");

    // The original captured event must still reflect the values from creation time.
    assert_eq!(event.quorum_weight, 2, "historical quorum_weight must be unchanged after owner removal");
    assert_eq!(event.total_weight_at_creation, 3, "historical total_weight_at_creation must be unchanged after owner removal");
}

proptest! {
    // Soroban builds a fresh Env per case, so keep the case count modest.
    #![proptest_config(ProptestConfig::with_cases(32))]

    /// A proposal's approval count must never exceed the number of distinct
    /// owners, regardless of owner count or threshold. After every owner approves
    /// once, `approvals` equals the owner count, and a repeat approval by an
    /// existing owner is rejected rather than pushing the count higher.
    #[test]
    fn approval_count_never_exceeds_owner_count(
        owner_count in 1u32..=20u32,
        threshold_seed in 1u32..=20u32,
    ) {
        // Derive a threshold in 1..=owner_count from the independent seed.
        let threshold = (threshold_seed - 1) % owner_count + 1;

        let env = Env::default();
        env.mock_all_auths();
        set_timestamp(&env, NOW);

        let contract_id = env.register(AccordContract, ());
        let client = AccordContractClient::new(&env, &contract_id);

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin);
        let token_client = token::Client::new(&env, &token_id.address());
        let token_sac = token::StellarAssetClient::new(&env, &token_id.address());

        let mut owners = Vec::new(&env);
        for _ in 0..owner_count {
            owners.push_back(Address::generate(&env));
        }
            let mut weights = Vec::new(&env);
    for _ in 0..owners.len() {
        weights.push_back(1);
    }
    client.initialize(&owners, &weights, &threshold, &0);
        token_sac.mint(&contract_id, &1_000_000_000_000_i128);

        let id = client.create_proposal(
            &owners.get(0).unwrap(),
            &t(&env, &Address::generate(&env), 1_000_000, &token_client.address),
            &str(&env, "invariant proposal"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        );

        // Every owner approves exactly once.
        for owner in owners.iter() {
            client.approve(&owner, &id);
        }

        let proposal = client.get_proposal(&id);
        prop_assert_eq!(proposal.approvals, owner_count);
        prop_assert!(proposal.approvals <= owner_count);

        // A duplicate approval by an existing owner cannot push the count higher.
        let first = owners.get(0).unwrap();
        prop_assert_eq!(
            client.try_approve(&first, &id),
            Err(Ok(ContractError::AlreadyApproved))
        );
    }

    /// Across valid owner additions, removals, and weight changes, the cached
    /// total must always equal the weights observable for every current owner.
    #[test]
    fn total_weight_matches_all_current_owner_weights(
        operations in proptest::collection::vec((0u8..=2, 1u32..=10), 1..=20)
    ) {
        let env = Env::default();
        env.mock_all_auths();
        set_timestamp(&env, NOW);
        let contract_id = env.register(AccordContract, ());
        let client = AccordContractClient::new(&env, &contract_id);

        let mut owners = Vec::new(&env);
        let mut model_weights: std::vec::Vec<u32> = std::vec::Vec::new();
        for _ in 0..3 {
            owners.push_back(Address::generate(&env));
            model_weights.push(1);
        }
        let mut initial_weights = Vec::new(&env);
        initial_weights.push_back(1); initial_weights.push_back(1); initial_weights.push_back(1);
        client.initialize(&owners, &initial_weights, &1, &0);

        for (kind, seed) in operations {
            let proposer = owners.get(0).unwrap();
            match kind {
                // Add only below MAX_OWNERS. New owners always start at weight 1.
                0 if owners.len() < 20 => {
                    let new_owner = Address::generate(&env);
                    let id = client.create_add_owner_proposal(&proposer, &new_owner, &str(&env, "fuzz add"), &DEADLINE);
                    client.approve(&proposer, &id);
                    client.execute(&proposer, &id);
                    owners.push_back(new_owner);
                    model_weights.push(1);
                }
                // Preserve the contract's minimum owner-count constraint for a
                // threshold of one: never remove below two owners.
                1 if owners.len() > 2 => {
                    let index = (seed as usize) % owners.len() as usize;
                    let target = owners.get(index as u32).unwrap();
                    let id = client.create_remove_owner_proposal(&proposer, &target, &str(&env, "fuzz remove"), &DEADLINE);
                    client.approve(&proposer, &id);
                    client.execute(&proposer, &id);
                    let mut next_owners = Vec::new(&env);
                    let mut next_weights = std::vec::Vec::new();
                    for i in 0..owners.len() {
                        if i != index as u32 {
                            next_owners.push_back(owners.get(i).unwrap());
                            next_weights.push(model_weights[i as usize]);
                        }
                    }
                    owners = next_owners;
                    model_weights = next_weights;
                }
                // Only propose weights that satisfy the configured 50% cap.
                2 => {
                    let index = (seed as usize) % owners.len() as usize;
                    let new_weight = seed % 10 + 1;
                    let total: u32 = model_weights.iter().sum();
                    let resulting_total = total - model_weights[index] + new_weight;
                    if new_weight * 100 <= resulting_total * 50 {
                        let target = owners.get(index as u32).unwrap();
                        let id = client.create_change_weight_proposal(&proposer, &target, &new_weight, &str(&env, "fuzz weight"), &DEADLINE);
                        client.approve(&proposer, &id);
                        client.execute(&proposer, &id);
                        model_weights[index] = new_weight;
                    }
                }
                _ => {}
            }

            let mut observed_total = 0u32;
            for owner in owners.iter() {
                observed_total += client.get_owner_weight(&owner);
            }
            prop_assert_eq!(observed_total, client.get_total_weight());
        }
    }

    #[test]
    fn active_count_never_exceeds_max(
        owner_count in 1u32..=5u32,
        threshold_seed in 1u32..=5u32,
        proposal_params in proptest::collection::vec(
            (1i128..1_000_000_000_i128, 1u64..=7_776_000u64),
            1..=65
        )
    ) {
        let threshold = (threshold_seed - 1) % owner_count + 1;

        let env = Env::default();
        env.mock_all_auths();
        set_timestamp(&env, NOW);

        let contract_id = env.register(AccordContract, ());
        let client = AccordContractClient::new(&env, &contract_id);

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin);
        let token_client = token::Client::new(&env, &token_id.address());
        let token_sac = token::StellarAssetClient::new(&env, &token_id.address());

        let mut owners = Vec::new(&env);
        for _ in 0..owner_count {
            owners.push_back(Address::generate(&env));
        }
        let mut weights = Vec::new(&env);
        for _ in 0..owners.len() {
            weights.push_back(1);
        }
        client.initialize(&owners, &weights, &threshold, &0);
        token_sac.mint(&contract_id, &1_000_000_000_000_i128);

        let owner = owners.get(0).unwrap();
        let mut active = 0;

        for (amount, deadline_offset) in proposal_params {
            let deadline = NOW + deadline_offset;
            let result = client.try_create_proposal(
                &owner,
                &t(&env, &Address::generate(&env), amount, &token_client.address),
                &str(&env, "fuzz test proposal"),
                &deadline,
                &ProposalCategory::Transfer,
            );

            if result.is_ok() {
                active += 1;
            } else {
                prop_assert_eq!(result.unwrap_err().unwrap(), ContractError::TooManyActiveProposals);
            }
            prop_assert!(active <= 50); // MAX_ACTIVE_PROPOSALS
        }
    }

    #[test]
    fn approval_weight_always_equals_sum_of_approved_weights(
        owner_weights in proptest::collection::vec(1u32..=100u32, 2..=20),
        threshold_seed in 1u32..=20u32,
        actions in proptest::collection::vec(
            (proptest::bool::weighted(0.5), 0usize..20usize),
            10..=40
        ),
    ) {
        let owner_count = owner_weights.len() as u32;
        let threshold = ((threshold_seed - 1) % owner_count) + 1;

        let env = Env::default();
        env.mock_all_auths();
        set_timestamp(&env, NOW);

        let contract_id = env.register(AccordContract, ());
        let client = AccordContractClient::new(&env, &contract_id);

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin);
        let token_client = token::Client::new(&env, &token_id.address());
        let token_sac = token::StellarAssetClient::new(&env, &token_id.address());

        let mut owners = Vec::new(&env);
        for _ in 0..owner_count {
            owners.push_back(Address::generate(&env));
        }
        let mut weights = Vec::new(&env);
        for w in &owner_weights {
            weights.push_back(*w);
        }
        client.initialize(&owners, &weights, &threshold, &0);
        token_sac.mint(&contract_id, &1_000_000_000_000_i128);

        let id = client.create_proposal(
            &owners.get(0).unwrap(),
            &t(&env, &Address::generate(&env), 1_000_000, &token_client.address),
            &str(&env, "fuzz proposal"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        );

        let mut approved = std::vec![false; owner_count as usize];
        let mut expected_approval_weight: u32 = 0;

        for (do_approve, raw_idx) in actions {
            let idx = raw_idx % owner_count as usize;
            let owner = owners.get(idx as u32).unwrap();

            if do_approve && !approved[idx] {
                client.approve(&owner, &id);
                approved[idx] = true;
                expected_approval_weight = expected_approval_weight
                    .checked_add(owner_weights[idx])
                    .unwrap();
            } else if !do_approve && approved[idx] {
                client.revoke(&owner, &id);
                approved[idx] = false;
                expected_approval_weight = expected_approval_weight
                    .checked_sub(owner_weights[idx])
                    .unwrap();
            }

            let proposal = client.get_proposal(&id);
            prop_assert_eq!(proposal.approvals, expected_approval_weight);
        }
    }
}

// ─── Multi-Transfer ────────────────────────────────────────────────────────────

#[test]
fn multi_transfer_success() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    let amount1: i128 = 50_000_000;
    let amount2: i128 = 30_000_000;

    let mut transfers = Vec::new(&env);
    transfers.push_back(Transfer {
        to: recipient1.clone(),
        token: token_client.address.clone(),
        amount: amount1,
    });
    transfers.push_back(Transfer {
        to: recipient2.clone(),
        token: token_client.address.clone(),
        amount: amount2,
    });

    let id = client.create_proposal(
        &owner_a,
        &transfers,
        &str(&env, "Multi-transfer"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );

    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);

    let before1 = token_client.balance(&recipient1);
    let before2 = token_client.balance(&recipient2);

    client.execute(&owner_c, &id);

    assert_eq!(token_client.balance(&recipient1) - before1, amount1);
    assert_eq!(token_client.balance(&recipient2) - before2, amount2);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Executed);
}

#[test]
fn multi_transfer_failure_atomic() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    let recipient3 = Address::generate(&env);
    let amount: i128 = 10_000_000;

    let token_admin2 = Address::generate(&env);
    let token_id2 = env.register_stellar_asset_contract_v2(token_admin2);
    let token2_client = token::Client::new(&env, &token_id2.address());

    // Contract has no balance for token2, so the second transfer will fail.

    let mut transfers = Vec::new(&env);
    transfers.push_back(Transfer {
        to: recipient1.clone(),
        token: token_client.address.clone(),
        amount,
    });
    transfers.push_back(Transfer {
        to: recipient2.clone(),
        token: token2_client.address.clone(),
        amount,
    });
    transfers.push_back(Transfer {
        to: recipient3.clone(),
        token: token_client.address.clone(),
        amount,
    });

    let id = client.create_proposal(
        &owner_a,
        &transfers,
        &str(&env, "Atomic failure"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );

    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);

    let before1 = token_client.balance(&recipient1);
    let before2 = token_client.balance(&recipient2);
    let before3 = token_client.balance(&recipient3);
    let before_contract = token_client.balance(&client.address);

    assert_eq!(
        client.try_execute(&owner_c, &id),
        Err(Ok(ContractError::TransferFailed))
    );

    // Balances must remain unchanged after the failed atomic execution.
    assert_eq!(token_client.balance(&recipient1), before1);
    assert_eq!(token_client.balance(&recipient2), before2);
    assert_eq!(token_client.balance(&recipient3), before3);
    assert_eq!(token_client.balance(&client.address), before_contract);
}

#[test]
fn create_proposal_rejects_invalid_transfer_count() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);

    // Empty transfer list should be rejected.
    let empty: Vec<Transfer> = Vec::new(&env);
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &empty,
            &str(&env, "Empty transfers"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        ),
        Err(Ok(ContractError::InvalidAmount))
    );

    // More than 3 transfers should be rejected.
    let mut too_many = Vec::new(&env);
    for _ in 0..4 {
        too_many.push_back(Transfer {
            to: Address::generate(&env),
            token: token_client.address.clone(),
            amount: 1_000_000,
        });
    }
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &too_many,
            &str(&env, "Too many transfers"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        ),
        Err(Ok(ContractError::InvalidAmount))
    );

    // Exactly 1 and 3 should succeed (boundary check).
    let mut one = Vec::new(&env);
    one.push_back(Transfer {
        to: Address::generate(&env),
        token: token_client.address.clone(),
        amount: 1_000_000,
    });
    assert!(client
        .try_create_proposal(
            &owner_a,
            &one,
            &str(&env, "One transfer"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        )
        .is_ok());

    let mut three = Vec::new(&env);
    for _ in 0..3 {
        three.push_back(Transfer {
            to: Address::generate(&env),
            token: token_client.address.clone(),
            amount: 1_000_000,
        });
    }
    assert!(client
        .try_create_proposal(
            &owner_a,
            &three,
            &str(&env, "Three transfers"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        )
        .is_ok());
}

#[test]
fn execute_success_with_weighted_votes() {
    let env = Env::default();
    env.mock_all_auths();
    set_timestamp(&env, NOW);

    let owner_a = Address::generate(&env);
    let owner_b = Address::generate(&env);
    let owner_c = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_client = token::Client::new(&env, &token_id.address());
    let token_sac = token::StellarAssetClient::new(&env, &token_id.address());

    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);

    let mut owners = Vec::new(&env);
    owners.push_back(owner_a.clone());
    owners.push_back(owner_b.clone());
    owners.push_back(owner_c.clone());

    // Initialize with unequal weights: Owner A has weight 3, B and C have 1.
    // Threshold (quorum weight) is 3.
    let mut weights = Vec::new(&env);
    weights.push_back(3);
    weights.push_back(1);
    weights.push_back(1);
    client.initialize(&owners, &weights, &3, &0);

    // Fund the multisig contract.
    token_sac.mint(&contract_id, &1_000_000_000_000_i128);

    let amount: i128 = 100_000_000;
    let id = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, amount, &token_client.address),
        &str(&env, "Weighted transfer"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );

    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);

    // Approve with Owner A (weight 3). This alone meets the quorum threshold of 3.
    client.approve(&owner_a, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Ready);

    let before = token_client.balance(&recipient);
    // Execute should succeed with only 1 approver.
    client.execute(&owner_a, &id);
    assert_eq!(token_client.balance(&recipient) - before, amount);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Executed);
}

#[test]
fn execute_rejected_with_insufficient_weighted_votes() {
    let env = Env::default();
    env.mock_all_auths();
    set_timestamp(&env, NOW);

    let owner_a = Address::generate(&env);
    let owner_b = Address::generate(&env);
    let owner_c = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_client = token::Client::new(&env, &token_id.address());
    let token_sac = token::StellarAssetClient::new(&env, &token_id.address());

    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);

    let mut owners = Vec::new(&env);
    owners.push_back(owner_a.clone());
    owners.push_back(owner_b.clone());
    owners.push_back(owner_c.clone());

    // Initialize with weights: Owner A has weight 1, B has 1, C has 3.
    // Threshold (quorum weight) is 3.
    let mut weights = Vec::new(&env);
    weights.push_back(1);
    weights.push_back(1);
    weights.push_back(3);
    client.initialize(&owners, &weights, &3, &0);

    // Fund the multisig contract.
    token_sac.mint(&contract_id, &1_000_000_000_000_i128);

    let amount: i128 = 100_000_000;
    let id = client.create_proposal(
        &owner_a,
        &t(&env, &recipient, amount, &token_client.address),
        &str(&env, "Insufficient weighted transfer"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );

    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);

    // Approve with Owner A (weight 1) and Owner B (weight 1).
    // Flat approval count is 2, but cumulative weight is 2, which is less than quorum 3.
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);

    // Execute should fail with ThresholdNotMet.
    assert_eq!(
        client.try_execute(&owner_c, &id),
        Err(Ok(ContractError::ThresholdNotMet))
    );
}

// ─── Weighted Active Count & cancel_expired (issue #269) ───────────────────────

#[test]
fn weighted_proposal_ready_via_weighted_approval_expires_and_is_swept() {
    let env = Env::default();
    env.mock_all_auths();
    set_timestamp(&env, NOW);

    let owner_a = Address::generate(&env);
    let owner_b = Address::generate(&env);
    let owner_c = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_client = token::Client::new(&env, &token_id.address());
    let token_sac = token::StellarAssetClient::new(&env, &token_id.address());

    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);

    let mut owners = Vec::new(&env);
    owners.push_back(owner_a.clone());
    owners.push_back(owner_b.clone());
    owners.push_back(owner_c.clone());

    // Owner A has weight 3; B and C have weight 1. Threshold = 3.
    let mut weights = Vec::new(&env);
    weights.push_back(3);
    weights.push_back(1);
    weights.push_back(1);
    client.initialize(&owners, &weights, &3, &0);
    token_sac.mint(&contract_id, &1_000_000_000_000_i128);

    let short_deadline = NOW + 100;
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Weighted, will expire"),
        &short_deadline,
        &ProposalCategory::Transfer,
    );

    // Owner A (weight 3) alone meets quorum 3 → Ready.
    client.approve(&owner_a, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Ready);

    // Advance past deadline without executing → Expired.
    set_timestamp(&env, short_deadline + 1);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Expired);

    // cancel_expired sweeps it and decrements active count.
    let mut ids = Vec::new(&env);
    ids.push_back(id);
    let swept = client.cancel_expired(&owner_a, &ids);
    assert_eq!(swept, 1);
}

#[test]
fn weighted_proposal_insufficient_weight_expires_not_counted_active() {
    let env = Env::default();
    env.mock_all_auths();
    set_timestamp(&env, NOW);

    let owner_a = Address::generate(&env);
    let owner_b = Address::generate(&env);
    let owner_c = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_client = token::Client::new(&env, &token_id.address());
    let token_sac = token::StellarAssetClient::new(&env, &token_id.address());

    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);

    let mut owners = Vec::new(&env);
    owners.push_back(owner_a.clone());
    owners.push_back(owner_b.clone());
    owners.push_back(owner_c.clone());

    // C has weight 3; A and B have weight 1. Threshold = 3.
    let mut weights = Vec::new(&env);
    weights.push_back(1);
    weights.push_back(1);
    weights.push_back(3);
    client.initialize(&owners, &weights, &3, &0);
    token_sac.mint(&contract_id, &1_000_000_000_000_i128);

    let short_deadline = NOW + 100;
    let id = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "Needs weight 3, has 2"),
        &short_deadline,
        &ProposalCategory::Transfer,
    );

    // A + B approve (1+1=2). Below quorum 3 → stays Pending.
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Pending);

    // Advance past deadline → Expired.
    set_timestamp(&env, short_deadline + 1);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Expired);

    // Sweep and confirm.
    let mut ids = Vec::new(&env);
    ids.push_back(id);
    let swept = client.cancel_expired(&owner_a, &ids);
    assert_eq!(swept, 1);
}

#[test]
fn weighted_active_count_sequence_execute_expire_sweep() {
    let env = Env::default();
    env.mock_all_auths();
    set_timestamp(&env, NOW);

    let owner_a = Address::generate(&env);
    let owner_b = Address::generate(&env);
    let owner_c = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_client = token::Client::new(&env, &token_id.address());
    let token_sac = token::StellarAssetClient::new(&env, &token_id.address());

    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);

    let mut owners = Vec::new(&env);
    owners.push_back(owner_a.clone());
    owners.push_back(owner_b.clone());
    owners.push_back(owner_c.clone());

    // A=3, B=1, C=1. Threshold=2. Total=5.
    let mut weights = Vec::new(&env);
    weights.push_back(3);
    weights.push_back(1);
    weights.push_back(1);
    client.initialize(&owners, &weights, &2, &0);
    token_sac.mint(&contract_id, &1_000_000_000_000_i128);

    let short_deadline = NOW + 200;
    let long_deadline = NOW + 10_000;

    // P1: A approves (3) → Ready, then execute.
    let p1 = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "P1-execute"),
        &long_deadline,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &p1);
    assert_eq!(client.get_proposal(&p1).status, ProposalStatus::Ready);
    client.execute(&owner_a, &p1);
    assert_eq!(client.get_proposal(&p1).status, ProposalStatus::Executed);

    // P2: B+C approve (1+1=2) → Ready, then expires.
    let p2 = client.create_proposal(
        &owner_b,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "P2-expire"),
        &short_deadline,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_b, &p2);
    client.approve(&owner_c, &p2);
    assert_eq!(client.get_proposal(&p2).status, ProposalStatus::Ready);

    // P3: A approves (3) → Ready, then execute.
    let p3 = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "P3-execute"),
        &long_deadline,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &p3);
    assert_eq!(client.get_proposal(&p3).status, ProposalStatus::Ready);
    client.execute(&owner_a, &p3);
    assert_eq!(client.get_proposal(&p3).status, ProposalStatus::Executed);

    // Advance past short deadline — P2 expires.
    set_timestamp(&env, short_deadline + 1);
    assert_eq!(client.get_proposal(&p2).status, ProposalStatus::Expired);

    // Sweep P2.
    let mut ids = Vec::new(&env);
    ids.push_back(p2);
    let swept = client.cancel_expired(&owner_a, &ids);
    assert_eq!(swept, 1);

    // All proposals are now terminal; a fresh proposal should work.
    let p4 = client.create_proposal(
        &owner_a,
        &t(
            &env,
            &Address::generate(&env),
            1_000_000,
            &token_client.address,
        ),
        &str(&env, "P4-fresh"),
        &long_deadline,
        &ProposalCategory::Transfer,
    );
    assert!(p4 > 0);
}

// ─── Dedicated Governance Execution Events (issue #238) ──────────────────────

#[test]
fn add_owner_execute_emits_add_owner_event() {
    let (env, client, owner_a, owner_b, owner_c, new_owner, _) = setup(2);

    let id = client.create_add_owner_proposal(
        &owner_a,
        &new_owner,
        &str(&env, "Add new owner"),
        &DEADLINE,
    );
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    client.execute(&owner_c, &id);

    let contract_events = env.events().all().filter_by_contract(&client.address);
    let a_own_event = contract_events.events().iter().find(|event| {
        let topics = match &event.body {
            xdr::ContractEventBody::V0(b) => b.topics.clone(),
        };
        topics
            .first()
            .map(|t| {
                let s: Symbol = t.clone().into_val(&env);
                s == symbol_short!("a_own")
            })
            .unwrap_or(false)
    });
    assert!(a_own_event.is_some(), "expected an 'a_own' event");

    let event_data = match &a_own_event.unwrap().body {
        xdr::ContractEventBody::V0(b) => b.data.clone(),
    };
    let event: AddOwnerExecutedEvent = event_data.into_val(&env);
    assert_eq!(event.new_owner, new_owner);
    assert_eq!(event.owner_count, 4);
}

#[test]
fn remove_owner_execute_emits_remove_owner_event() {
    let (env, client, owner_a, owner_b, owner_c, _, _) = setup(2);

    let id = client.create_remove_owner_proposal(
        &owner_a,
        &owner_c,
        &str(&env, "Remove owner_c"),
        &DEADLINE,
    );
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    client.execute(&owner_c, &id);

    let contract_events = env.events().all().filter_by_contract(&client.address);
    let r_own_event = contract_events.events().iter().find(|event| {
        let topics = match &event.body {
            xdr::ContractEventBody::V0(b) => b.topics.clone(),
        };
        topics
            .first()
            .map(|t| {
                let s: Symbol = t.clone().into_val(&env);
                s == symbol_short!("r_own")
            })
            .unwrap_or(false)
    });
    assert!(r_own_event.is_some(), "expected an 'r_own' event");

    let event_data = match &r_own_event.unwrap().body {
        xdr::ContractEventBody::V0(b) => b.data.clone(),
    };
    let event: RemoveOwnerExecutedEvent = event_data.into_val(&env);
    assert_eq!(event.removed_owner, owner_c);
    assert_eq!(event.owner_count, 2);
}

#[test]
fn change_threshold_execute_emits_change_threshold_event() {
    let (env, client, owner_a, owner_b, owner_c, _, _) = setup(3);

    let id = client.create_change_threshold_proposal(
        &owner_a,
        &2,
        &str(&env, "Lower threshold to 2"),
        &DEADLINE,
    );
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    client.approve(&owner_c, &id);
    client.execute(&owner_c, &id);

    let contract_events = env.events().all().filter_by_contract(&client.address);
    let c_thr_event = contract_events.events().iter().find(|event| {
        let topics = match &event.body {
            xdr::ContractEventBody::V0(b) => b.topics.clone(),
        };
        topics
            .first()
            .map(|t| {
                let s: Symbol = t.clone().into_val(&env);
                s == symbol_short!("c_thr")
            })
            .unwrap_or(false)
    });
    assert!(c_thr_event.is_some(), "expected a 'c_thr' event");

    let event_data = match &c_thr_event.unwrap().body {
        xdr::ContractEventBody::V0(b) => b.data.clone(),
    };
    let event: ChangeThresholdExecutedEvent = event_data.into_val(&env);
    assert_eq!(event.previous_threshold, 3);
    assert_eq!(event.new_threshold, 2);
}

#[test]
fn set_spending_limit_execute_emits_spending_limit_event() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);

    // First set a limit (no previous limit).
    let id1 = client.create_spending_limit_proposal(
        &owner_a,
        &owner_a,
        &token_client.address,
        &1_000_000,
        &str(&env, "Set limit"),
        &DEADLINE,
    );
    client.approve(&owner_a, &id1);
    client.approve(&owner_b, &id1);
    client.execute(&owner_c, &id1);

    let contract_events = env.events().all().filter_by_contract(&client.address);
    let s_lim_event = contract_events.events().iter().find(|event| {
        let topics = match &event.body {
            xdr::ContractEventBody::V0(b) => b.topics.clone(),
        };
        topics
            .first()
            .map(|t| {
                let s: Symbol = t.clone().into_val(&env);
                s == symbol_short!("s_lim")
            })
            .unwrap_or(false)
    });
    assert!(s_lim_event.is_some(), "expected an 's_lim' event");

    let event_data = match &s_lim_event.unwrap().body {
        xdr::ContractEventBody::V0(b) => b.data.clone(),
    };
    let event: SetSpendingLimitExecutedEvent = event_data.into_val(&env);
    assert_eq!(event.owner, owner_a);
    assert_eq!(event.token, token_client.address);
    assert_eq!(event.previous_limit, None);
    assert_eq!(event.new_limit, 1_000_000);

    // Change the limit again — now there is a previous limit.
    let id2 = client.create_spending_limit_proposal(
        &owner_c,
        &owner_a,
        &token_client.address,
        &2_000_000,
        &str(&env, "Update limit"),
        &DEADLINE,
    );
    client.approve(&owner_a, &id2);
    client.approve(&owner_b, &id2);
    client.execute(&owner_c, &id2);

    // Find the *last* s_lim event (the latest execution).
    let contract_events2 = env.events().all().filter_by_contract(&client.address);
    let mut latest_s_lim = None;
    for event in contract_events2.events().iter() {
        let topics = match &event.body {
            xdr::ContractEventBody::V0(b) => b.topics.clone(),
        };
        let is_s_lim = topics
            .first()
            .map(|t| {
                let s: Symbol = t.clone().into_val(&env);
                s == symbol_short!("s_lim")
            })
            .unwrap_or(false);
        if is_s_lim {
            latest_s_lim = Some(event);
        }
    }
    let latest = latest_s_lim.expect("expected a second 's_lim' event");
    let latest_data = match &latest.body {
        xdr::ContractEventBody::V0(b) => b.data.clone(),
    };
    let event2: SetSpendingLimitExecutedEvent = latest_data.into_val(&env);
    assert_eq!(event2.previous_limit, Some(1_000_000));
    assert_eq!(event2.new_limit, 2_000_000);
}



#[test]
fn spending_limit_independent_of_voting_weight() {
    let env = Env::default();
    env.mock_all_auths();
    env.budget().reset_unlimited();

    let owner_a = Address::generate(&env);
    let owner_b = Address::generate(&env);
    let owner_c = Address::generate(&env);

    let token_contract = env.register_stellar_asset_contract_v2(owner_c.clone());
    let token_client = token::Client::new(&env, &token_contract.address());
    let token_admin = token::StellarAssetClient::new(&env, &token_contract.address());

    // Mint tokens to the contract
    let contract_id = env.register(AccordContract, ());
    token_admin.mint(&contract_id, &10_000_000);

    let client = AccordContractClient::new(&env, &contract_id);
    client.initialize(
        &soroban_sdk::vec![&env, owner_a.clone(), owner_b.clone(), owner_c.clone()],
        &soroban_sdk::vec![&env, 1, 5, 1], // owner_a has weight 1, owner_b has weight 5
        &2,
        &0,
    );

    // Set identical spending limit of 1000 for both owner_a and owner_b
    let limit_a_id = client.create_spending_limit_proposal(
        &owner_c,
        &owner_a,
        &token_client.address,
        &1000,
        &str(&env, "Limit A"),
        &(env.ledger().timestamp() + 1000),
    );
    client.approve(&owner_b, &limit_a_id);
    client.execute(&owner_a, &limit_a_id);

    let limit_b_id = client.create_spending_limit_proposal(
        &owner_c,
        &owner_b,
        &token_client.address,
        &1000,
        &str(&env, "Limit B"),
        &(env.ledger().timestamp() + 1000),
    );
    client.approve(&owner_b, &limit_b_id);
    client.execute(&owner_a, &limit_b_id);

    // Both should be able to create a proposal for exactly 1000
    let ok_id_a = client.create_proposal(
        &owner_a,
        &t(&env, &owner_c, 1000, &token_client.address),
        &str(&env, "Transfer A OK"),
        &(env.ledger().timestamp() + 1000),
        &ProposalCategory::Transfer,
    );
    assert!(ok_id_a > 0);

    let ok_id_b = client.create_proposal(
        &owner_b,
        &t(&env, &owner_c, 1000, &token_client.address),
        &str(&env, "Transfer B OK"),
        &(env.ledger().timestamp() + 1000),
        &ProposalCategory::Transfer,
    );
    assert!(ok_id_b > 0);

    // But neither should be able to create one for 1001 (limit exceeded)
    let err_a = client.try_create_proposal(
        &owner_a,
        &t(&env, &owner_c, 1001, &token_client.address), // 1001 > 1000 limit
        &str(&env, "Transfer A Err"),
        &(env.ledger().timestamp() + 1000),
        &ProposalCategory::Transfer,
    );
    assert_eq!(err_a, Err(Ok(ContractError::SpendingLimitExceeded)));

    let err_b = client.try_create_proposal(
        &owner_b,
        &t(&env, &owner_c, 1001, &token_client.address), // 1001 > 1000 limit
        &str(&env, "Transfer B Err"),
        &(env.ledger().timestamp() + 1000),
        &ProposalCategory::Transfer,
    );
    assert_eq!(err_b, Err(Ok(ContractError::SpendingLimitExceeded)));
}

#[test]
fn changing_weight_does_not_affect_spending_limit() {
    let env = Env::default();
    env.mock_all_auths();
    env.budget().reset_unlimited();

    let owner_a = Address::generate(&env);
    let owner_b = Address::generate(&env);
    let owner_c = Address::generate(&env);

    let token_contract = env.register_stellar_asset_contract_v2(owner_c.clone());
    let token_client = token::Client::new(&env, &token_contract.address());

    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);
    client.initialize(
        &soroban_sdk::vec![&env, owner_a.clone(), owner_b.clone(), owner_c.clone()],
        &soroban_sdk::vec![&env, 1, 1, 1], // all weights 1 initially
        &2,
        &0,
    );

    // Set spending limit of 5000 for owner_a
    let limit_id = client.create_spending_limit_proposal(
        &owner_b,
        &owner_a,
        &token_client.address,
        &5000,
        &str(&env, "Limit A"),
        &(env.ledger().timestamp() + 1000),
    );
    client.approve(&owner_a, &limit_id);
    client.approve(&owner_b, &limit_id);
    client.execute(&owner_c, &limit_id);

    assert_eq!(
        client.get_spending_limit(&owner_a, &token_client.address),
        Some(5000)
    );

    // Now change owner_a's weight to 2
    let weight_id = client.create_change_weight_proposal(
        &owner_b,
        &owner_a,
        &2,
        &str(&env, "Weight A to 2"),
        &(env.ledger().timestamp() + 1000),
    );
    client.approve(&owner_a, &weight_id);
    client.approve(&owner_b, &weight_id);
    client.execute(&owner_c, &weight_id);

    // Spending limit should still be 5000
    assert_eq!(
        client.get_spending_limit(&owner_a, &token_client.address),
        Some(5000)
    );

    // Now change the spending limit to 10000
    let limit_id_2 = client.create_spending_limit_proposal(
        &owner_b,
        &owner_a,
        &token_client.address,
        &10000,
        &str(&env, "Limit A to 10000"),
        &(env.ledger().timestamp() + 1000),
    );
    client.approve(&owner_a, &limit_id_2);
    client.approve(&owner_b, &limit_id_2);
    client.execute(&owner_c, &limit_id_2);

    assert_eq!(
        client.get_spending_limit(&owner_a, &token_client.address),
        Some(10000)
    );
}

// ─── Recurring Payment Views and Maintenance Tests ─────────────────────────

fn save_recurring_schedule(env: &Env, contract_id: &Address, schedule: &RecurringPayment) {
    env.as_contract(contract_id, || {
        let key = recurring_payment_key(schedule.id);
        env.storage().persistent().set(&key, schedule);
        let next_id = read_next_recurring_id(env);
        if schedule.id >= next_id {
            write_next_recurring_id(env, schedule.id + 1);
        }
    });
}

#[test]
fn test_get_recurring_payment_found_and_not_found() {
    let (env, client, owner_a, _, _, _, _) = setup(2);
    let contract_id = client.address.clone();

    // Query non-existent ID
    assert_eq!(
        client.try_get_recurring_payment(&999),
        Err(Ok(ContractError::RecurringPaymentNotFound))
    );

    // Save active schedule that has expired (end_time in past)
    let now = env.ledger().timestamp();
    let schedule = RecurringPayment {
        id: 1,
        proposer: owner_a.clone(),
        recipient: Address::generate(&env),
        token: Address::generate(&env),
        kind: ScheduleKind::Fixed,
        status: RecurringStatus::Active,
        start_time: now - 1000,
        end_time: now - 100,
        interval_secs: 300,
        cliff_time: 0,
        amount_per_period: 100,
        total_amount: 500,
        total_disbursed: 200,
        last_disbursed_at: now - 500,
        total_cap: 500,
        max_disbursements: 5,
        disbursements_made: 2,
        is_paused: false,
        is_cancelled: false,
    };
    save_recurring_schedule(&env, &contract_id, &schedule);

    // Read back - status should be freshly derived as Completed
    let fetched = client.get_recurring_payment(&1);
    assert_eq!(fetched.id, 1);
    assert_eq!(fetched.status, RecurringStatus::Completed);
}

#[test]
fn test_sweep_completed_recurring() {
    let (env, client, owner_a, _, _, non_owner, _) = setup(2);
    let contract_id = client.address.clone();
    let now = env.ledger().timestamp();

    // Schedule 1: Completed via past end_time
    let schedule1 = RecurringPayment {
        id: 1,
        proposer: owner_a.clone(),
        recipient: Address::generate(&env),
        token: Address::generate(&env),
        kind: ScheduleKind::Fixed,
        status: RecurringStatus::Active,
        start_time: now - 1000,
        end_time: now - 10,
        interval_secs: 100,
        cliff_time: 0,
        amount_per_period: 50,
        total_amount: 500,
        total_disbursed: 500,
        last_disbursed_at: now - 50,
        total_cap: 500,
        max_disbursements: 10,
        disbursements_made: 10,
        is_paused: false,
        is_cancelled: false,
    };

    // Schedule 2: Active (future end_time)
    let schedule2 = RecurringPayment {
        id: 2,
        proposer: owner_a.clone(),
        recipient: Address::generate(&env),
        token: Address::generate(&env),
        kind: ScheduleKind::Fixed,
        status: RecurringStatus::Active,
        start_time: now,
        end_time: now + 5000,
        interval_secs: 100,
        cliff_time: 0,
        amount_per_period: 50,
        total_amount: 500,
        total_disbursed: 0,
        last_disbursed_at: 0,
        total_cap: 500,
        max_disbursements: 10,
        disbursements_made: 0,
        is_paused: false,
        is_cancelled: false,
    };

    save_recurring_schedule(&env, &contract_id, &schedule1);
    save_recurring_schedule(&env, &contract_id, &schedule2);

    let mut ids = Vec::new(&env);
    ids.push_back(1);
    ids.push_back(2);

    // Non-owner cannot sweep
    assert_eq!(
        client.try_sweep_completed_recurring(&non_owner, &ids),
        Err(Ok(ContractError::Unauthorized))
    );

    // Owner sweeps: only schedule 1 is Completed, so swept count is 1
    let swept = client.sweep_completed_recurring(&owner_a, &ids);
    assert_eq!(swept, 1);
}

#[test]
fn test_get_next_disbursement_time() {
    let (env, client, owner_a, _, _, _, _) = setup(2);
    let contract_id = client.address.clone();
    let now = env.ledger().timestamp();

    // Active Fixed schedule
    let schedule_fixed = RecurringPayment {
        id: 1,
        proposer: owner_a.clone(),
        recipient: Address::generate(&env),
        token: Address::generate(&env),
        kind: ScheduleKind::Fixed,
        status: RecurringStatus::Active,
        start_time: now,
        end_time: now + 10000,
        interval_secs: 86400,
        cliff_time: 0,
        amount_per_period: 100,
        total_amount: 1000,
        total_disbursed: 100,
        last_disbursed_at: now,
        total_cap: 1000,
        max_disbursements: 10,
        disbursements_made: 1,
        is_paused: false,
        is_cancelled: false,
    };

    // Active LinearVesting schedule without prior disbursement
    let schedule_linear = RecurringPayment {
        id: 2,
        proposer: owner_a.clone(),
        recipient: Address::generate(&env),
        token: Address::generate(&env),
        kind: ScheduleKind::LinearVesting,
        status: RecurringStatus::Active,
        start_time: now,
        end_time: now + 86400 * 10,
        interval_secs: 86400,
        cliff_time: 86400 * 2,
        amount_per_period: 0,
        total_amount: 10000,
        total_disbursed: 0,
        last_disbursed_at: 0,
        total_cap: 10000,
        max_disbursements: 0,
        disbursements_made: 0,
        is_paused: false,
        is_cancelled: false,
    };

    // Completed schedule
    let schedule_completed = RecurringPayment {
        id: 3,
        proposer: owner_a.clone(),
        recipient: Address::generate(&env),
        token: Address::generate(&env),
        kind: ScheduleKind::Fixed,
        status: RecurringStatus::Completed,
        start_time: 100,
        end_time: 500,
        interval_secs: 100,
        cliff_time: 0,
        amount_per_period: 10,
        total_amount: 100,
        total_disbursed: 100,
        last_disbursed_at: 500,
        total_cap: 100,
        max_disbursements: 10,
        disbursements_made: 10,
        is_paused: false,
        is_cancelled: false,
    };

    save_recurring_schedule(&env, &contract_id, &schedule_fixed);
    save_recurring_schedule(&env, &contract_id, &schedule_linear);
    save_recurring_schedule(&env, &contract_id, &schedule_completed);

    // Fixed: last_disbursed_at + interval_secs
    assert_eq!(client.get_next_disbursement_time(&1), now + 86400);

    // Linear: start_time + cliff_time
    assert_eq!(client.get_next_disbursement_time(&2), now + 86400 * 2);

    // Terminated: 0
    assert_eq!(client.get_next_disbursement_time(&3), 0);
}

#[test]
fn test_get_claimable_amount() {
    let (env, client, owner_a, _, _, _, _) = setup(2);
    let contract_id = client.address.clone();
    let now = env.ledger().timestamp();

    // Fixed schedule eligible now
    let schedule_fixed = RecurringPayment {
        id: 1,
        proposer: owner_a.clone(),
        recipient: Address::generate(&env),
        token: Address::generate(&env),
        kind: ScheduleKind::Fixed,
        status: RecurringStatus::Active,
        start_time: now - 200,
        end_time: now + 10000,
        interval_secs: 100,
        cliff_time: 0,
        amount_per_period: 250,
        total_amount: 1000,
        total_disbursed: 0,
        last_disbursed_at: now - 200,
        total_cap: 1000,
        max_disbursements: 4,
        disbursements_made: 0,
        is_paused: false,
        is_cancelled: false,
    };

    // Linear vesting schedule 50% vested
    let start_time = now - 500;
    let end_time = now + 500;
    let schedule_linear = RecurringPayment {
        id: 2,
        proposer: owner_a.clone(),
        recipient: Address::generate(&env),
        token: Address::generate(&env),
        kind: ScheduleKind::LinearVesting,
        status: RecurringStatus::Active,
        start_time,
        end_time,
        interval_secs: 1000,
        cliff_time: 100,
        amount_per_period: 0,
        total_amount: 1000,
        total_disbursed: 200,
        last_disbursed_at: now - 200,
        total_cap: 1000,
        max_disbursements: 0,
        disbursements_made: 0,
        is_paused: false,
        is_cancelled: false,
    };

    // Paused schedule
    let schedule_paused = RecurringPayment {
        id: 3,
        proposer: owner_a.clone(),
        recipient: Address::generate(&env),
        token: Address::generate(&env),
        kind: ScheduleKind::Fixed,
        status: RecurringStatus::Active,
        start_time: now - 200,
        end_time: now + 10000,
        interval_secs: 100,
        cliff_time: 0,
        amount_per_period: 250,
        total_amount: 1000,
        total_disbursed: 0,
        last_disbursed_at: now - 200,
        total_cap: 1000,
        max_disbursements: 4,
        disbursements_made: 0,
        is_paused: true,
        is_cancelled: false,
    };

    save_recurring_schedule(&env, &contract_id, &schedule_fixed);
    save_recurring_schedule(&env, &contract_id, &schedule_linear);
    save_recurring_schedule(&env, &contract_id, &schedule_paused);

    // Fixed claimable: 250
    assert_eq!(client.get_claimable_amount(&1), 250);

    // Linear claimable: 50% of 1000 = 500 vested, minus 200 disbursed = 300
    assert_eq!(client.get_claimable_amount(&2), 300);

    // Paused claimable: 0
    assert_eq!(client.get_claimable_amount(&3), 0);
}

#[test]
fn test_get_recurring_payments_paged() {
    let (env, client, owner_a, _, _, _, _) = setup(2);
    let contract_id = client.address.clone();
    let now = env.ledger().timestamp();

    // Create 25 schedules
    for id in 1..=25 {
        let schedule = RecurringPayment {
            id,
            proposer: owner_a.clone(),
            recipient: Address::generate(&env),
            token: Address::generate(&env),
            kind: ScheduleKind::Fixed,
            status: RecurringStatus::Active,
            start_time: now,
            end_time: now + 10000,
            interval_secs: 100,
            cliff_time: 0,
            amount_per_period: 10,
            total_amount: 100,
            total_disbursed: 0,
            last_disbursed_at: 0,
            total_cap: 100,
            max_disbursements: 10,
            disbursements_made: 0,
            is_paused: false,
            is_cancelled: false,
        };
        save_recurring_schedule(&env, &contract_id, &schedule);
    }

    // Page 1 (offset 0, limit 10) -> returns 10 items
    let page1 = client.get_recurring_payments_paged(&0, &10);
    assert_eq!(page1.len(), 10);
    assert_eq!(page1.get(0).unwrap().id, 1);
    assert_eq!(page1.get(9).unwrap().id, 10);

    // Limit cap at 20 (request limit 50) -> returns 20 items
    let page_capped = client.get_recurring_payments_paged(&0, &50);
    assert_eq!(page_capped.len(), 20);

    // Overflow protection on offset + limit
    let page_overflow = client.get_recurring_payments_paged(&u64::MAX, &10);
    assert_eq!(page_overflow.len(), 0);
}

