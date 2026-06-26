// Issue #87: dedicated validation module for proposal and approval logic
use soroban_sdk::{Address, Env, String};
use crate::{ContractError, MAX_DESCRIPTION_LEN, MIN_AMOUNT, MAX_PROPOSAL_DURATION};

pub fn validate_amount(amount: i128) -> Result<(), ContractError> {
    if amount < MIN_AMOUNT {
        return Err(ContractError::InvalidAmount);
    }
    Ok(())
}

pub fn validate_deadline(env: &Env, deadline: u64) -> Result<(), ContractError> {
    let now = env.ledger().timestamp();
    if deadline <= now {
        return Err(ContractError::InvalidDeadline);
    }
    if deadline - now > MAX_PROPOSAL_DURATION {
        return Err(ContractError::InvalidDeadline);
    }
    Ok(())
}

pub fn validate_description(description: &String) -> Result<(), ContractError> {
    if description.len() == 0 {
        return Err(ContractError::EmptyDescription);
    }
    if description.len() > MAX_DESCRIPTION_LEN {
        return Err(ContractError::EmptyDescription);
    }
    Ok(())
}

pub fn validate_recipient(env: &Env, recipient: &Address) -> Result<(), ContractError> {
    if recipient == &env.current_contract_address() {
        return Err(ContractError::InvalidToken);
    }
    Ok(())
}
