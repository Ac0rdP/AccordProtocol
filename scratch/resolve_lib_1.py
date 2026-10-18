import re

with open('contracts/accord/src/lib.rs', 'r') as f:
    content = f.read()

# Conflict 1: lines 271-425
# Keep max_single_owner_weight_pct_key, read_max_single_owner_weight_pct, owner_weight_within_cap
# Remove owner_weight_key, read_owner_weight
content = re.sub(
    r'<<<<<<< HEAD\nfn max_single_owner_weight_pct_key.*?=======\n>>>>>>> .*?\n',
    r'''fn max_single_owner_weight_pct_key() -> Symbol {
    symbol_short!("MAXOWNP")
}

fn read_max_single_owner_weight_pct(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&max_single_owner_weight_pct_key())
        .unwrap_or(DEFAULT_MAX_SINGLE_OWNER_WEIGHT_PCT)
}

fn owner_weight_within_cap(env: &Env, owner_weight: u32, total_weight: u32) -> bool {
    // Widen before multiplying so the comparison cannot overflow u32.
    (owner_weight as u64) * 100
        <= (total_weight as u64) * (read_max_single_owner_weight_pct(env) as u64)
}
''', content, flags=re.DOTALL)

with open('contracts/accord/src/lib.rs', 'w') as f:
    f.write(content)
