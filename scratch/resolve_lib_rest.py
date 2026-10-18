import re

with open('contracts/accord/src/lib.rs', 'r') as f:
    content = f.read()

# Conflict 2 (ChangeOwnerWeight execution)
# HEAD: 
# <<<<<<< HEAD
#                 // Zero is intentionally disallowed: it leaves an address listed as
#                 // an owner while unable to vote. Use RemoveOwner instead.
#                 if !(MIN_OWNER_WEIGHT..=MAX_OWNER_WEIGHT).contains(new_weight) {
#                     return Err(ContractError::InvalidWeight);
#                 }
#                 let old_weight = read_owner_weight(&env, target_owner);
# =======
#                 let mut owners = read_owners_map(&env)?;
#                 let old_weight = owners.get(target_owner.clone()).ok_or(ContractError::OwnerNotFound)?;
# >>>>>>>
content = re.sub(
    r'<<<<<<< HEAD\n.*?if !\(MIN_OWNER_WEIGHT..=MAX_OWNER_WEIGHT\)\.contains\(new_weight\) \{\n.*?return Err\(ContractError::InvalidWeight\);\n.*?\}\n.*?let old_weight = read_owner_weight\(&env, target_owner\);\n=======\n.*?let mut owners = read_owners_map\(&env\)\?;\n.*?let old_weight = owners\.get\(target_owner\.clone\(\)\)\.ok_or\(ContractError::OwnerNotFound\)\?;\n>>>>>>> .*?\n',
    r'''                if !(MIN_OWNER_WEIGHT..=MAX_OWNER_WEIGHT).contains(new_weight) {
                    return Err(ContractError::InvalidWeight);
                }
                let mut owners = read_owners_map(&env)?;
                let old_weight = owners.get(target_owner.clone()).ok_or(ContractError::OwnerNotFound)?;
''', content, flags=re.DOTALL)


# For the rest (set_guardian, unfreeze, upgrade), we just keep HEAD and discard the refactor branch block.
def keep_head(m):
    return m.group(1)

content = re.sub(r'<<<<<<< HEAD\n(.*?)=======\n.*?>>>>>>> .*?\n', keep_head, content, flags=re.DOTALL)

with open('contracts/accord/src/lib.rs', 'w') as f:
    f.write(content)
