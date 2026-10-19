#![no_main]

use accord::{AccordContract, AccordContractClient, ContractError, Proposal, ProposalStatus};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env, String, Symbol, Vec};

const ACTIVE_PROPOSAL_CAP: u32 = 50;
const MAX_INITIAL_PROPOSALS: u8 = 50;
const MAX_RANDOM_OPERATIONS: usize = 64;
const NOW: u64 = 1_000;

fn create_proposal(
    env: &Env,
    client: &AccordContractClient,
    proposer: &Address,
    deadline: u64,
) -> u64 {
    client.create_change_threshold_proposal(
        proposer,
        &1,
        &String::from_str(env, "Fuzz proposal bookkeeping"),
        &deadline,
    )
}

fn read_active_count(env: &Env, client: &AccordContractClient) -> u32 {
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .get::<_, u32>(&Symbol::new(env, "ACTCNT"))
            .unwrap_or(0)
    })
}

fn assert_bookkeeping(env: &Env, client: &AccordContractClient, expected_next_id: u64) {
    let total_proposals = client.get_total_proposals();
    assert_eq!(
        total_proposals + 1,
        expected_next_id,
        "the next proposal ID must strictly increase and never be reused"
    );

    let mut live_count = 0_u32;
    for expected_id in 1..expected_next_id {
        let proposal: Proposal = client.get_proposal(&expected_id);
        assert_eq!(
            proposal.id, expected_id,
            "proposal ID {} was missing or reused",
            expected_id
        );
        if matches!(
            proposal.status,
            ProposalStatus::Pending | ProposalStatus::Ready
        ) {
            live_count = live_count
                .checked_add(1)
                .expect("live proposal count overflowed");
        }
    }

    let active_count = read_active_count(env, client);
    assert!(
        active_count <= ACTIVE_PROPOSAL_CAP,
        "active proposal count {} exceeded cap {}",
        active_count,
        ACTIVE_PROPOSAL_CAP
    );
    assert_eq!(
        active_count, live_count,
        "stored active count {} drifted from {} live proposals",
        active_count, live_count
    );
}

fn proposal_ids(env: &Env, expected_next_id: u64) -> Vec<u64> {
    let mut ids = Vec::new(&env);
    for id in 1..expected_next_id {
        ids.push_back(id);
    }
    ids
}

fuzz_target!(|data: &[u8]| {
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

    let mut expected_next_id = 1_u64;
    let initial_count = data
        .first()
        .copied()
        .unwrap_or(0)
        .min(MAX_INITIAL_PROPOSALS);
    for i in 0..initial_count {
        let deadline = NOW + 1 + u64::from(data.get(i as usize + 1).copied().unwrap_or(i) % 100);
        if read_active_count(&env, &client) < ACTIVE_PROPOSAL_CAP {
            let id = create_proposal(&env, &client, &owners[0], deadline);
            assert_eq!(
                id, expected_next_id,
                "created proposal ID was reused or skipped"
            );
            expected_next_id += 1;
        } else {
            assert_eq!(
                client.try_create_change_threshold_proposal(
                    &owners[0],
                    &1,
                    &String::from_str(&env, "Fuzz proposal at active cap"),
                    &deadline,
                ),
                Err(Ok(ContractError::TooManyActiveProposals)),
                "creating beyond the active proposal cap must fail"
            );
        }
        assert_bookkeeping(&env, &client, expected_next_id);
    }
    if read_active_count(&env, &client) == ACTIVE_PROPOSAL_CAP {
        assert_eq!(
            client.try_create_change_threshold_proposal(
                &owners[0],
                &1,
                &String::from_str(&env, "Fuzz proposal at active cap"),
                &(env.ledger().timestamp() + 1),
            ),
            Err(Ok(ContractError::TooManyActiveProposals)),
            "creating beyond the active proposal cap must fail"
        );
        assert_bookkeeping(&env, &client, expected_next_id);
    }

    for (step, operation) in data
        .iter()
        .skip(1 + usize::from(initial_count))
        .take(MAX_RANDOM_OPERATIONS)
        .enumerate()
    {
        let proposal_count = expected_next_id - 1;
        match operation % 5 {
            0 => {
                let now = env.ledger().timestamp();
                let deadline = now + 1 + u64::from(*operation % 100);
                if read_active_count(&env, &client) < ACTIVE_PROPOSAL_CAP {
                    let proposer = &owners[usize::from(*operation / 5) % owners.len()];
                    let id = create_proposal(&env, &client, proposer, deadline);
                    assert_eq!(
                        id, expected_next_id,
                        "created proposal ID was reused or skipped at operation {step}"
                    );
                    expected_next_id += 1;
                } else {
                    assert_eq!(
                        client.try_create_change_threshold_proposal(
                            &owners[0],
                            &1,
                            &String::from_str(&env, "Fuzz proposal at active cap"),
                            &deadline,
                        ),
                        Err(Ok(ContractError::TooManyActiveProposals)),
                        "creating beyond the active proposal cap must fail"
                    );
                }
            }
            1 | 2 | 3 if proposal_count > 0 => {
                let proposal_id = 1 + u64::from(*operation) % proposal_count;
                let proposal = client.get_proposal(&proposal_id);
                let owner = &owners[usize::from(*operation / 5) % owners.len()];
                match operation % 5 {
                    1 if matches!(
                        proposal.status,
                        ProposalStatus::Pending | ProposalStatus::Ready
                    ) && !client.has_approved(&proposal_id, owner) =>
                    {
                        client.approve(owner, &proposal_id);
                    }
                    2 if matches!(
                        proposal.status,
                        ProposalStatus::Pending | ProposalStatus::Ready
                    ) && client.has_approved(&proposal_id, owner) =>
                    {
                        client.revoke(owner, &proposal_id);
                    }
                    3 if proposal.status == ProposalStatus::Ready => {
                        client.execute(owner, &proposal_id);
                    }
                    _ => {}
                }
            }
            4 => {
                let now = env.ledger().timestamp();
                let delta = 1 + u64::from(*operation);
                env.ledger()
                    .with_mut(|ledger| ledger.timestamp = now.saturating_add(delta));
                let ids = proposal_ids(&env, expected_next_id);
                client.cancel_expired(&owners[0], &ids);
            }
            _ => {}
        }

        assert_bookkeeping(&env, &client, expected_next_id);
    }
});
