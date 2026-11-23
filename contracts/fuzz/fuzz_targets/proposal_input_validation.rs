#![no_main]

use accord::{AccordContract, AccordContractClient, ContractError};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env, IntoVal, String, Symbol, Val, Vec};

const NOW: u64 = 1_000;
const MAX_DESCRIPTION_LEN: usize = 300;
const MAX_PROPOSAL_DURATION: u64 = 7_776_000;
const MAX_FUZZ_DESCRIPTION_BYTES: usize = 600;
const CATEGORY_NAMES: [&str; 5] = ["Transfer", "Payroll", "Grant", "Ops", "Other"];

/// Deadlines clustered around the interesting boundaries, plus fully arbitrary values.
fn pick_deadline(selector: u8, raw: u64) -> u64 {
    match selector % 10 {
        0 => 0,
        1 => NOW - 1,
        2 => NOW,
        3 => NOW + 1,
        4 => NOW + MAX_PROPOSAL_DURATION - 1,
        5 => NOW + MAX_PROPOSAL_DURATION,
        6 => NOW + MAX_PROPOSAL_DURATION + 1,
        7 => u64::MAX,
        8 => u64::MAX - raw % 4,
        _ => raw,
    }
}

fn expected_deadline_error(deadline: u64) -> Option<ContractError> {
    if deadline <= NOW {
        Some(ContractError::InvalidDeadline)
    } else if deadline - NOW > MAX_PROPOSAL_DURATION {
        Some(ContractError::InvalidDuration)
    } else {
        None
    }
}

fn expected_description_error(len: usize) -> Option<ContractError> {
    if len == 0 {
        Some(ContractError::EmptyDescription)
    } else if len > MAX_DESCRIPTION_LEN {
        Some(ContractError::DescriptionTooLong)
    } else {
        None
    }
}

/// Builds a category value from fuzz bytes. Returns the encoded value and whether it is a
/// well-formed `ProposalCategory`.
fn build_category(env: &Env, selector: u8, bytes: &[u8]) -> (Val, bool) {
    match selector % 6 {
        // Valid unit variant: Vec[Symbol(name)].
        0 => {
            let name = CATEGORY_NAMES[bytes.first().copied().unwrap_or(0) as usize % 5];
            let v: Vec<Symbol> = Vec::from_array(env, [Symbol::new(env, name)]);
            (v.into_val(env), true)
        }
        // Vec[Symbol(arbitrary identifier)] - almost always an unknown variant.
        1 => {
            let sanitized: std::string::String = bytes
                .iter()
                .take(32)
                .map(|b| match b % 63 {
                    n @ 0..=25 => (b'a' + n) as char,
                    n @ 26..=51 => (b'A' + (n - 26)) as char,
                    n @ 52..=61 => (b'0' + (n - 52)) as char,
                    _ => '_',
                })
                .collect();
            let valid = CATEGORY_NAMES.contains(&sanitized.as_str());
            let v: Vec<Symbol> = Vec::from_array(env, [Symbol::new(env, &sanitized)]);
            (v.into_val(env), valid)
        }
        // Empty vec, or too many elements for a unit variant.
        2 => {
            let mut v: Vec<Symbol> = Vec::new(env);
            for _ in 0..(bytes.len() % 3) * 2 {
                v.push_back(Symbol::new(env, "Other"));
            }
            (v.into_val(env), false)
        }
        // Wrong primitive types.
        3 => {
            let raw = bytes.first().copied().unwrap_or(0) as u32;
            (raw.into_val(env), false)
        }
        // Bare symbol (not wrapped in a vec) and arbitrary string.
        4 => (Symbol::new(env, "Transfer").into_val(env), false),
        _ => (String::from_bytes(env, bytes).into_val(env), false),
    }
}

fuzz_target!(|data: &[u8]| {
    if data.len() < 12 {
        return;
    }
    let (header, rest) = data.split_at(12);
    let deadline_selector = header[0];
    let category_selector = header[1];
    let mut raw = [0_u8; 8];
    raw.copy_from_slice(&header[2..10]);
    let raw_deadline = u64::from_le_bytes(raw);
    let desc_len_hint = u16::from_le_bytes([header[10], header[11]]) as usize;

    let desc_len = (desc_len_hint % (MAX_FUZZ_DESCRIPTION_BYTES + 1)).min(rest.len());
    let description_bytes = &rest[..desc_len];
    let category_bytes = &rest[desc_len..];

    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|ledger| ledger.timestamp = NOW);

    let owners = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);
    client.initialize(
        &Vec::from_array(&env, owners.clone()),
        &Vec::from_array(&env, [1, 1, 1]),
        &1,
        &0,
    );

    let description = String::from_bytes(&env, description_bytes);
    let deadline = pick_deadline(deadline_selector, raw_deadline);

    // Description and deadline: errors are reported in the order description, then deadline.
    let expected = expected_description_error(description_bytes.len())
        .or_else(|| expected_deadline_error(deadline));
    let result =
        client.try_create_change_threshold_proposal(&owners[0], &1, &description, &deadline);
    match expected {
        Some(err) => assert_eq!(
            result,
            Err(Ok(err)),
            "invalid description/deadline must be rejected with the matching error"
        ),
        None => assert!(
            result.is_ok(),
            "valid description and deadline must be accepted: {:?}",
            result
        ),
    }

    // Category: encodings that are not a ProposalCategory must be rejected without panicking
    // the host. Empty transfers make a well-formed call fail later with InvalidAmount, so that
    // error proves the category decoded.
    let (category, category_valid) = build_category(&env, category_selector, category_bytes);
    let transfers: Val = Vec::<Val>::new(&env).into_val(&env);
    let args: Vec<Val> = Vec::from_array(
        &env,
        [
            owners[0].into_val(&env),
            transfers,
            description.into_val(&env),
            deadline.into_val(&env),
            category,
        ],
    );
    let outcome = env.try_invoke_contract::<u64, ContractError>(
        &contract_id,
        &Symbol::new(&env, "create_proposal"),
        args,
    );
    if category_valid {
        assert_eq!(
            outcome,
            Err(Ok(ContractError::InvalidAmount)),
            "a valid category with no transfers must reach the transfer check"
        );
    } else {
        assert!(outcome.is_err(), "malformed category must be rejected");
        assert_ne!(
            outcome,
            Err(Ok(ContractError::InvalidAmount)),
            "malformed category must be rejected before transfer validation"
        );
    }
});
