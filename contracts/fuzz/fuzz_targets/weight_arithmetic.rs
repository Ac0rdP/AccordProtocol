#![no_main]

use accord::{AccordContract, AccordContractClient, OwnerWeight, Proposal};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env, String, Vec};

const MAX_OWNER_WEIGHT: u32 = 100_000;
const MAX_TOTAL_WEIGHT: u32 = 2_000_000;
const MAX_OWNERS: usize = 20;
const NOW: u64 = 1_000;
const DEADLINE: u64 = NOW + 86_400;

#[derive(Clone, Copy)]
struct TrackedProposal {
    id: u64,
    snapshot_total_weight: u32,
    recorded_approval_weight: u32,
}

struct Input<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Input<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn next_u32(&mut self) -> u32 {
        let mut value = [0_u8; 4];
        if self.bytes.is_empty() {
            return 0;
        }
        for byte in &mut value {
            *byte = self.bytes[self.offset % self.bytes.len()];
            self.offset += 1;
        }
        u32::from_le_bytes(value)
    }

    fn weight(&mut self, upper_bound: u32) -> u32 {
        let value = self.next_u32();
        match value % 8 {
            0 => 1,
            1 => upper_bound,
            _ => value % upper_bound + 1,
        }
    }
}

fn assert_invariants(client: &AccordContractClient, proposals: &[TrackedProposal]) {
    let owner_weights: Vec<OwnerWeight> = client.get_owner_weights();
    let mut owner_weight_sum = 0_u32;
    for owner_weight in owner_weights.iter() {
        owner_weight_sum = owner_weight_sum
            .checked_add(owner_weight.weight)
            .expect("sum of in-bounds owner weights overflowed");
    }
    assert_eq!(
        owner_weight_sum,
        client.get_total_weight(),
        "stored total weight drifted from the current owner-weight sum"
    );

    for tracked in proposals {
        let proposal: Proposal = client.get_proposal(&tracked.id);
        assert!(
            proposal.approval_weight <= tracked.snapshot_total_weight,
            "proposal {} approval weight {} exceeded creation-time total {}",
            tracked.id,
            proposal.approval_weight,
            tracked.snapshot_total_weight
        );
        assert_eq!(
            proposal.approval_weight, tracked.recorded_approval_weight,
            "proposal {} approval weight drifted from its recorded votes",
            tracked.id
        );
        assert_eq!(
            proposal.approvals, tracked.recorded_approval_weight,
            "proposal {} cumulative approvals drifted from its recorded votes",
            tracked.id
        );
    }
}

fn finish_proposal(
    client: &AccordContractClient,
    approvers: &[Address],
    proposal_id: u64,
    snapshot_total_weight: u32,
    proposals: &mut std::vec::Vec<TrackedProposal>,
) {
    proposals.push(TrackedProposal {
        id: proposal_id,
        snapshot_total_weight,
        recorded_approval_weight: 0,
    });
    let tracked_index = proposals.len() - 1;

    for approver in approvers {
        let approval_weight = client.get_owner_weight(approver);
        client.approve(approver, &proposal_id);
        proposals[tracked_index].recorded_approval_weight = proposals[tracked_index]
            .recorded_approval_weight
            .checked_add(approval_weight)
            .expect("approval weights overflowed");
        assert_invariants(client, proposals);
    }

    let first_approver = approvers
        .first()
        .expect("fuzz generated an empty owner list");
    let first_approval_weight = client.get_owner_weight(first_approver);
    client.revoke(first_approver, &proposal_id);
    proposals[tracked_index].recorded_approval_weight = proposals[tracked_index]
        .recorded_approval_weight
        .checked_sub(first_approval_weight)
        .expect("revoked approval weight exceeded total approvals");
    assert_invariants(client, proposals);

    client.approve(first_approver, &proposal_id);
    proposals[tracked_index].recorded_approval_weight = proposals[tracked_index]
        .recorded_approval_weight
        .checked_add(first_approval_weight)
        .expect("approval weights overflowed after re-approval");
    assert_invariants(client, proposals);

    client.execute(first_approver, &proposal_id);
    assert_invariants(client, proposals);
}

fn create_and_finish_change_threshold(
    env: &Env,
    client: &AccordContractClient,
    proposer: &Address,
    approvers: &[Address],
    proposals: &mut std::vec::Vec<TrackedProposal>,
) {
    let snapshot_total_weight = client.get_total_weight();
    let proposal_id = client.create_change_threshold_proposal(
        proposer,
        &1,
        &String::from_str(env, "Fuzz approval lifecycle"),
        &DEADLINE,
    );
    finish_proposal(
        client,
        approvers,
        proposal_id,
        snapshot_total_weight,
        proposals,
    );
}

fn create_and_finish_add_owner(
    env: &Env,
    client: &AccordContractClient,
    proposer: &Address,
    approvers: &[Address],
    new_owner: Address,
    weight: u32,
    proposals: &mut std::vec::Vec<TrackedProposal>,
) {
    let snapshot_total_weight = client.get_total_weight();
    let proposal_id = client.create_add_owner_proposal(
        proposer,
        &new_owner,
        &weight,
        &String::from_str(env, "Fuzz add owner"),
        &DEADLINE,
    );
    finish_proposal(
        client,
        approvers,
        proposal_id,
        snapshot_total_weight,
        proposals,
    );
}

fn create_and_finish_remove_owner(
    env: &Env,
    client: &AccordContractClient,
    proposer: &Address,
    approvers: &[Address],
    owner_to_remove: &Address,
    proposals: &mut std::vec::Vec<TrackedProposal>,
) {
    let snapshot_total_weight = client.get_total_weight();
    let proposal_id = client.create_remove_owner_proposal(
        proposer,
        owner_to_remove,
        &String::from_str(env, "Fuzz remove owner"),
        &DEADLINE,
    );
    finish_proposal(
        client,
        approvers,
        proposal_id,
        snapshot_total_weight,
        proposals,
    );
}

fn create_and_finish_change_weight(
    env: &Env,
    client: &AccordContractClient,
    proposer: &Address,
    approvers: &[Address],
    target_owner: &Address,
    new_weight: u32,
    proposals: &mut std::vec::Vec<TrackedProposal>,
) {
    let snapshot_total_weight = client.get_total_weight();
    let proposal_id = client.create_change_weight_proposal(
        proposer,
        target_owner,
        &new_weight,
        &String::from_str(env, "Fuzz change weight"),
        &DEADLINE,
    );
    finish_proposal(
        client,
        approvers,
        proposal_id,
        snapshot_total_weight,
        proposals,
    );
}

fuzz_target!(|data: &[u8]| {
    let mut input = Input::new(data);
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|ledger| ledger.timestamp = NOW);

    let owners = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    let weights = [
        input.weight(MAX_OWNER_WEIGHT),
        input.weight(MAX_OWNER_WEIGHT),
        input.weight(MAX_OWNER_WEIGHT),
        input.weight(MAX_OWNER_WEIGHT),
    ];
    let contract_id = env.register(AccordContract, ());
    let client = AccordContractClient::new(&env, &contract_id);
    client.initialize(
        &Vec::from_array(&env, owners.clone()),
        &Vec::from_array(&env, weights),
        &1,
        &0,
    );

    let mut current_owners = std::vec::Vec::from(owners);
    let mut proposals = std::vec::Vec::new();
    assert_invariants(&client, &proposals);

    create_and_finish_change_threshold(
        &env,
        &client,
        &current_owners[0],
        &current_owners,
        &mut proposals,
    );

    let first_added_owner = Address::generate(&env);
    let total_weight = client.get_total_weight();
    let add_weight = input.weight(
        total_weight
            .min(MAX_OWNER_WEIGHT)
            .min(MAX_TOTAL_WEIGHT - total_weight),
    );
    create_and_finish_add_owner(
        &env,
        &client,
        &current_owners[0],
        &current_owners,
        first_added_owner.clone(),
        add_weight,
        &mut proposals,
    );
    current_owners.push(first_added_owner);

    let target_index = input.next_u32() as usize % current_owners.len();
    let target_owner = current_owners[target_index].clone();
    let target_weight = client.get_owner_weight(&target_owner);
    let other_weight = client
        .get_total_weight()
        .checked_sub(target_weight)
        .expect("target owner weight exceeded total");
    let changed_weight = input.weight(other_weight.min(MAX_OWNER_WEIGHT));
    create_and_finish_change_weight(
        &env,
        &client,
        &current_owners[0],
        &current_owners,
        &target_owner,
        changed_weight,
        &mut proposals,
    );

    let remove_index = 1 + input.next_u32() as usize % (current_owners.len() - 1);
    let removed_owner = current_owners.remove(remove_index);
    create_and_finish_remove_owner(
        &env,
        &client,
        &current_owners[0],
        &current_owners,
        &removed_owner,
        &mut proposals,
    );

    for _ in 0..(input.next_u32() % 3) {
        match input.next_u32() % 4 {
            0 if current_owners.len() < MAX_OWNERS
                && client.get_total_weight() < MAX_TOTAL_WEIGHT =>
            {
                let new_owner = Address::generate(&env);
                let total_weight = client.get_total_weight();
                let weight = input.weight(
                    total_weight
                        .min(MAX_OWNER_WEIGHT)
                        .min(MAX_TOTAL_WEIGHT - total_weight),
                );
                create_and_finish_add_owner(
                    &env,
                    &client,
                    &current_owners[0],
                    &current_owners,
                    new_owner.clone(),
                    weight,
                    &mut proposals,
                );
                current_owners.push(new_owner);
            }
            1 => {
                let target_index = input.next_u32() as usize % current_owners.len();
                let target_owner = current_owners[target_index].clone();
                let target_weight = client.get_owner_weight(&target_owner);
                let other_weight = client
                    .get_total_weight()
                    .checked_sub(target_weight)
                    .expect("target owner weight exceeded total");
                let new_weight = input.weight(other_weight.min(MAX_OWNER_WEIGHT));
                create_and_finish_change_weight(
                    &env,
                    &client,
                    &current_owners[0],
                    &current_owners,
                    &target_owner,
                    new_weight,
                    &mut proposals,
                );
            }
            2 if current_owners.len() > 2 => {
                let remove_index = 1 + input.next_u32() as usize % (current_owners.len() - 1);
                let removed_owner = current_owners.remove(remove_index);
                create_and_finish_remove_owner(
                    &env,
                    &client,
                    &current_owners[0],
                    &current_owners,
                    &removed_owner,
                    &mut proposals,
                );
            }
            _ => {
                create_and_finish_change_threshold(
                    &env,
                    &client,
                    &current_owners[0],
                    &current_owners,
                    &mut proposals,
                );
            }
        }
    }
});
