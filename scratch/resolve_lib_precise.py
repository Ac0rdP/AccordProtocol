import sys

with open('contracts/accord/src/lib.rs', 'r') as f:
    lines = f.readlines()

out = []
i = 0
while i < len(lines):
    line = lines[i]
    if line.startswith('<<<<<<< HEAD'):
        # Collect HEAD block
        head_block = []
        i += 1
        while not lines[i].startswith('======='):
            head_block.append(lines[i])
            i += 1
        
        # Collect REFACTOR block
        refactor_block = []
        i += 1
        while not lines[i].startswith('>>>>>>>'):
            refactor_block.append(lines[i])
            i += 1
        
        # Now resolve based on content
        head_text = ''.join(head_block)
        refactor_text = ''.join(refactor_block)
        
        if 'max_single_owner_weight_pct_key' in head_text:
            # Conflict 1
            out.append('fn max_single_owner_weight_pct_key() -> Symbol {\n')
            out.append('    symbol_short!("MAXOWNP")\n')
            out.append('}\n\n')
            out.append('fn read_max_single_owner_weight_pct(env: &Env) -> u32 {\n')
            out.append('    env.storage()\n')
            out.append('        .instance()\n')
            out.append('        .get(&max_single_owner_weight_pct_key())\n')
            out.append('        .unwrap_or(DEFAULT_MAX_SINGLE_OWNER_WEIGHT_PCT)\n')
            out.append('}\n\n')
            out.append('fn owner_weight_within_cap(env: &Env, owner_weight: u32, total_weight: u32) -> bool {\n')
            out.append('    (owner_weight as u64) * 100\n')
            out.append('        <= (total_weight as u64) * (read_max_single_owner_weight_pct(env) as u64)\n')
            out.append('}\n')
        elif 'InvalidWeight' in head_text:
            # Conflict 2
            out.append('                if !(MIN_OWNER_WEIGHT..=MAX_OWNER_WEIGHT).contains(new_weight) {\n')
            out.append('                    return Err(ContractError::InvalidWeight);\n')
            out.append('                }\n')
            out.append('                let mut owners = read_owners_map(&env)?;\n')
            out.append('                let old_weight = owners.get(target_owner.clone()).ok_or(ContractError::OwnerNotFound)?;\n')
        elif 'require_weighted_approvers' in head_text:
            # Conflicts 3, 4, 5, 6
            out.append(head_text)
        else:
            # Keep HEAD by default
            out.append(head_text)
    else:
        out.append(line)
    i += 1

with open('contracts/accord/src/lib.rs', 'w') as f:
    f.writelines(out)
