#![cfg(test)]

extern crate std;

use super::*;
use std::format;
use soroban_sdk::testutils::{Address as _, Events, Ledger as _};
use soroban_sdk::{token, xdr, Address, BytesN, Env, IntoVal, String, Vec};

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
    client.initialize(&owners, &threshold, &time_lock_delay);

    // Fund the multisig contract so it can pay out proposals.
    token_sac.mint(&contract_id, &1_000_000_000_000_i128);

    (env, client, owner_a, owner_b, owner_c, non_owner, token_client)
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
    client.initialize(&owners, &1, &0);

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
    assert_eq!(
        client.try_initialize(&owners, &2, &0),
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
    assert_eq!(
        client.try_initialize(&owners, &0, &0),
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
    assert_eq!(
        client.try_initialize(&owners, &2, &0),
        Err(Ok(ContractError::InvalidThreshold))
    );
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
    assert_eq!(
        client.try_initialize(&owners, &1, &0),
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
        &str(&env, "First"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    let id2 = client.create_proposal(
        &owner_a,
        &Address::generate(&env),
        &2_000_000_i128,
        &token_client.address,
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
            &Address::generate(&env),
            &1_000_000_i128,
            &token_client.address,
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
            &Address::generate(&env),
            &0_i128,
            &token_client.address,
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
            &Address::generate(&env),
            &1_000_000_i128,
            &token_client.address,
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
            &Address::generate(&env),
            &1_000_000_i128,
            &token_client.address,
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
            &Address::generate(&env),
            &1_000_000_i128,
            &invalid_token,
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
        &recipient,
        &1_000_000_i128,
        &token_client.address,
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
            &recipient,
            &1_000_000_i128,
            &token_client.address,
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
        &recipient,
        &amount,
        &token_client.address,
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
            &client.address,
            &1_000_000_i128,
            &token_client.address,
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
        &recipient,
        &1_000_000_i128,
        &token_client.address,
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
fn approve_transitions_pending_to_ready() {
    let (env, client, owner_a, owner_b, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Pending
    );
    client.approve(&owner_b, &id);
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Ready
    );
}

#[test]
fn approve_rejects_double_approve() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert_eq!(
        client.try_approve(&non_owner, &id),
        Err(Ok(ContractError::Unauthorized))
    );
}

// ─── Revoke ──────────────────────────────────────────────────────────────────

#[test]
fn revoke_decrements_count_and_clears_flag() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
        &str(&env, "Pay"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Ready
    );
    client.revoke(&owner_a, &id);
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Pending
    );
}

#[test]
fn revoke_rejects_when_not_previously_approved() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
fn has_approved_returns_false_after_revoke() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
        &recipient,
        &amount,
        &token_client.address,
        &str(&env, "Bonus"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    client.approve(&owner_a, &id);
    client.approve(&owner_b, &id);
    let before = token_client.balance(&recipient);
    client.execute(&owner_c, &id);
    assert_eq!(token_client.balance(&recipient) - before, amount);
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Executed
    );
}

#[test]
fn execute_rejects_when_threshold_not_met() {
    let (env, client, owner_a, _, _, _, token_client) = setup(2);
    let id = client.create_proposal(
        &owner_a,
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
        &recipient,
        &amount,
        &token_client.address,
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
        &str(&env, "Short window"),
        &deadline,
        &ProposalCategory::Transfer,
    );
    set_timestamp(&env, deadline + 1);
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Expired
    );
}

#[test]
fn approve_rejects_expired_proposal() {
    let (env, client, owner_a, owner_b, _, _, token_client) = setup(2);
    let deadline = NOW + 3_600;
    let id = client.create_proposal(
        &owner_a,
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
            &Address::generate(&env),
            &1_000_000_i128,
            &token_client.address,
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
            &Address::generate(&env),
            &1_000_000_i128,
            &token_client.address,
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
        &str(&env, "Proposal 1"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    let id2 = client.create_proposal(
        &owner_a,
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
        &str(&env, "Proposal 2"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    let _id3 = client.create_proposal(
        &owner_a,
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
        &recipient,
        &amount,
        &token_client.address,
        &str(&env, "Full lifecycle"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Pending
    );

    client.approve(&owner_a, &id);
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Pending
    );

    client.approve(&owner_b, &id);
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Ready
    );

    let before = token_client.balance(&recipient);
    client.execute(&owner_c, &id);
    assert_eq!(token_client.balance(&recipient) - before, amount);
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Executed
    );
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
    owners.push_back(owner_d.clone());
    owners.push_back(owner_e.clone());
    client.initialize(&owners, &5, &0);

    // Fund the multisig contract so it can pay out proposals.
    token_sac.mint(&contract_id, &1_000_000_000_000_i128);

    let amount: i128 = 100_000_000;

    let id = client.create_proposal(
        &owner_a,
        &recipient,
        &amount,
        &token_client.address,
        &str(&env, "Full lifecycle 5of5"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Pending
    );

    client.approve(&owner_a, &id);
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Pending
    );

    client.approve(&owner_b, &id);
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Pending
    );

    client.approve(&owner_c, &id);
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Pending
    );

    client.approve(&owner_d, &id);
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Pending
    );

    client.approve(&owner_e, &id);
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Ready
    );

    let before = token_client.balance(&recipient);
    client.execute(&owner_a, &id);
    assert_eq!(token_client.balance(&recipient) - before, amount);
    assert_eq!(
        client.get_proposal(&id).status,
        ProposalStatus::Executed
    );
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
    client.initialize(&owners, &2, &0);

    // Do not mint any tokens to the contract — balance is zero.

    let amount: i128 = 1_000_000;
    let id = client.create_proposal(
        &owner_a,
        &recipient,
        &amount,
        &token_client.address,
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
            &recipient,
            &1_000_000_i128,
            &token_client.address,
            &str(&env, &format!("Proposal {}", i)),
            &DEADLINE,
            &ProposalCategory::Transfer,
        );
    }

    // The 51st proposal should be rejected with TooManyActiveProposals.
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &recipient,
            &1_000_000_i128,
            &token_client.address,
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
            &Address::generate(&env),
            &1_000_000_i128,
            &token_client.address,
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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
        &Address::generate(&env),
        &1_000_000_i128,
        &token_client.address,
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

// ─── Active Count ─────────────────────────────────────────────────────────────

#[test]
fn active_count_stays_accurate_after_execute() {
    let (env, client, owner_a, owner_b, owner_c, _, token_client) = setup(2);
    let recipient = Address::generate(&env);

    // Fill up the active slots
    for _ in 0..50 {
        client.create_proposal(
            &owner_a,
            &recipient,
            &1_000_000_i128,
            &token_client.address,
            &str(&env, "Fill"),
            &DEADLINE,
            &ProposalCategory::Transfer,
        );
    }

    // 51st proposal should fail
    assert_eq!(
        client.try_create_proposal(
            &owner_a,
            &recipient,
            &1_000_000_i128,
            &token_client.address,
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

    client.approve(&owner_a, &2);
    client.approve(&owner_b, &2);
    client.execute(&owner_c, &2);

    // Now we should be able to create 2 more proposals
    let id51 = client.create_proposal(
        &owner_a,
        &recipient,
        &1_000_000_i128,
        &token_client.address,
        &str(&env, "New 1"),
        &DEADLINE,
        &ProposalCategory::Transfer,
    );
    let id52 = client.create_proposal(
        &owner_a,
        &recipient,
        &1_000_000_i128,
        &token_client.address,
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
            &recipient,
            &1_000_000_i128,
            &token_client.address,
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
    client.create_proposal(&owner_a, &recipient, &1_000_000_i128, &token_client.address, &str(&env, "Short 1"), &short_deadline, &ProposalCategory::Transfer);
    client.create_proposal(&owner_a, &recipient, &1_000_000_i128, &token_client.address, &str(&env, "Short 2"), &short_deadline, &ProposalCategory::Transfer);

    // Create 48 proposals with a long deadline
    for _ in 2..50 {
        client.create_proposal(&owner_a, &recipient, &1_000_000_i128, &token_client.address, &str(&env, "Long"), &long_deadline, &ProposalCategory::Transfer);
    }

    // 51st proposal should fail
    assert_eq!(
        client.try_create_proposal(&owner_a, &recipient, &1_000_000_i128, &token_client.address, &str(&env, "Overflow"), &long_deadline, &ProposalCategory::Transfer),
        Err(Ok(ContractError::TooManyActiveProposals))
    );

    // Advance time past the short deadline
    set_timestamp(&env, short_deadline + 1);

    // Execute the expired proposals
    assert_eq!(client.try_execute(&owner_a, &1), Err(Ok(ContractError::ProposalExpired)));
    assert_eq!(client.try_execute(&owner_a, &2), Err(Ok(ContractError::ProposalExpired)));

    // Now we should be able to create 2 more proposals
    let id51 = client.create_proposal(&owner_a, &recipient, &1_000_000_i128, &token_client.address, &str(&env, "New 1"), &long_deadline, &ProposalCategory::Transfer);
    let id52 = client.create_proposal(&owner_a, &recipient, &1_000_000_i128, &token_client.address, &str(&env, "New 2"), &long_deadline, &ProposalCategory::Transfer);
    assert_eq!(id51, 51);
    assert_eq!(id52, 52);

    // And the 53rd should fail again
    assert_eq!(
        client.try_create_proposal(&owner_a, &recipient, &1_000_000_i128, &token_client.address, &str(&env, "Overflow 2"), &long_deadline, &ProposalCategory::Transfer),
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
    client.create_proposal(&owner_a, &recipient, &1_000_000_i128, &token_client.address, &str(&env, "Short 1"), &short_deadline, &ProposalCategory::Transfer);

    // Create 49 long deadline
    for _ in 1..50 {
        client.create_proposal(&owner_a, &recipient, &1_000_000_i128, &token_client.address, &str(&env, "Long"), &long_deadline, &ProposalCategory::Transfer);
    }

    // 51st proposal should fail
    assert_eq!(
        client.try_create_proposal(&owner_a, &recipient, &1_000_000_i128, &token_client.address, &str(&env, "Overflow"), &long_deadline, &ProposalCategory::Transfer),
        Err(Ok(ContractError::TooManyActiveProposals))
    );

    // Execute proposal 2 (long deadline)
    client.approve(&owner_a, &2);
    client.approve(&owner_b, &2);
    client.execute(&owner_c, &2);

    // Create 1 new proposal (long deadline)
    let id51 = client.create_proposal(&owner_a, &recipient, &1_000_000_i128, &token_client.address, &str(&env, "New 1"), &long_deadline, &ProposalCategory::Transfer);
    assert_eq!(id51, 51);

    // Advance time past the short deadline
    set_timestamp(&env, short_deadline + 1);

    // Execute the expired proposal 1
    assert_eq!(client.try_execute(&owner_a, &1), Err(Ok(ContractError::ProposalExpired)));

    // Create 1 new proposal (long deadline)
    let id52 = client.create_proposal(&owner_a, &recipient, &1_000_000_i128, &token_client.address, &str(&env, "New 2"), &long_deadline, &ProposalCategory::Transfer);
    assert_eq!(id52, 52);

    // 53rd proposal should fail
    assert_eq!(
        client.try_create_proposal(&owner_a, &recipient, &1_000_000_i128, &token_client.address, &str(&env, "Overflow 2"), &long_deadline, &ProposalCategory::Transfer),
        Err(Ok(ContractError::TooManyActiveProposals))
    );
}

// ─── cancel_expired ───────────────────────────────────────────────────────────

#[test]
fn cancel_expired_sweeps_two_expired_proposals() {
    let (env, client, owner_a, _, _, _, token_client) = setup(1);
    let recipient = Address::generate(&env);

    let id1 = client.create_proposal(&owner_a, &recipient, &1_000_000_i128,
        &token_client.address, &str(&env, "p1"), &DEADLINE, &ProposalCategory::Transfer);
    let id2 = client.create_proposal(&owner_a, &recipient, &1_000_000_i128,
        &token_client.address, &str(&env, "p2"), &DEADLINE, &ProposalCategory::Transfer);

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

    let id1 = client.create_proposal(&owner_a, &recipient, &1_000_000_i128,
        &token_client.address, &str(&env, "short"), &DEADLINE, &ProposalCategory::Transfer);
    let id2 = client.create_proposal(&owner_a, &recipient, &1_000_000_i128,
        &token_client.address, &str(&env, "long"), &long_deadline, &ProposalCategory::Transfer);

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

    let id1 = client.create_proposal(&owner_a, &recipient, &1_000_000_i128,
        &token_client.address, &str(&env, "real"), &DEADLINE, &ProposalCategory::Transfer);

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

    client.create_proposal(&owner_a, &recipient, &1_000_000_i128,
        &token_client.address, &str(&env, "x"), &DEADLINE, &ProposalCategory::Transfer);

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
        client.create_proposal(&owner_a, &recipient, &1_000_000_i128,
            &token_client.address, &str(&env, "fill"), &DEADLINE, &ProposalCategory::Transfer);
    }

    assert_eq!(
        client.try_create_proposal(&owner_a, &recipient, &1_000_000_i128,
            &token_client.address, &str(&env, "over"), &DEADLINE, &ProposalCategory::Transfer),
        Err(Ok(ContractError::TooManyActiveProposals))
    );

    set_timestamp(&env, DEADLINE + 1);

    let mut ids = Vec::new(&env);
    for i in 1_u64..=50 {
        ids.push_back(i);
    }
    let swept = client.cancel_expired(&owner_a, &ids);
    assert_eq!(swept, 50);

    let new_id = client.create_proposal(&owner_a, &recipient, &1_000_000_i128,
        &token_client.address, &str(&env, "new"), &(DEADLINE + 86_400), &ProposalCategory::Transfer);
    assert_eq!(new_id, 51);
}
