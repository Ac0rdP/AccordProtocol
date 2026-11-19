# Mutation Testing Configuration
# ================================
#
# Tool: cargo-mutants v25.1.1 (pinned in CI)
# Install: cargo install cargo-mutants@25.1.1 --locked
# Run locally:
#   cargo mutants --package accord \
#     --file contracts/accord/src/lib.rs \
#     --file contracts/accord/src/validate.rs \
#     --file contracts/accord/src/invariants.rs \
#     --timeout 300 --jobs 2 -- --lib
#
# Scope
# -----
# The mutation testing targets contract source files that contain:
#   - Authorization checks (require_auth, is_owner, role checks)
#   - Arithmetic (weight calculations, spending limits, amounts)
#   - State transitions (proposal lifecycle, recurring payment status)
#
# Excluded from mutation scope:
#   - contracts/accord/src/test.rs — test code
#   - contracts/accord/src/bench.rs — benchmark code
#   - Any generated code
#
# Equivalent Mutants (known false positives)
# ------------------------------------------
# These mutations produce no observable change in behavior. Each is recorded
# here with a reason so the team can review periodically.
#
# (none yet — populate after first full run)
#
# Threshold
# ---------
# The mutation score threshold is set at 60% for day one, based on the
# expectation that the existing test suite kills the majority of mutants in
# authorization and arithmetic code. This should be raised as tests improve.
#
# Adjusting the threshold:
#   1. Run a full mutation test to get the current score.
#   2. Set the threshold ~5 points below the measured score (headroom).
#   3. Update the threshold in .github/workflows/mutation-testing.yml.
#   4. Document the change in the PR description.
