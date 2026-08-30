// Issue #87: dedicated validation module for proposal and approval logic
use crate::{ContractError, MAX_DESCRIPTION_LEN, MAX_PROPOSAL_DURATION, MIN_AMOUNT};
use soroban_sdk::{Address, Env, String};

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
    if description.is_empty() {
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

pub fn validate_recurring_schedule(
    start_time: u64,
    cliff_time: u64,
    end_time: u64,
    total_cap: i128,
    amount_per_period: i128,
) -> Result<(), ContractError> {
    if end_time > 0 {
        if end_time <= start_time {
            return Err(ContractError::InvalidSchedule);
        }
        if cliff_time > 0 && cliff_time > end_time {
            return Err(ContractError::InvalidSchedule);
        }
    }
    if total_cap > 0 && total_cap < amount_per_period {
        return Err(ContractError::InvalidCap);
    }
    Ok(())
}
