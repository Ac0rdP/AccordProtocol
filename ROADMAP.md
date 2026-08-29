# Roadmap

Accord aims to become the default on-chain multisig treasury layer for teams building on Stellar. The roadmap is shaped by three priorities, applied in order: security first (audited contracts, hardened authorization), then usability (clean frontend, clear docs), and finally ecosystem reach (integrations, mainnet readiness). Each milestone below targets a concrete set of features and ships only when every acceptance criterion is met.

## Current status

The project is actively working toward **v0.2.0** (below). Open issues for this milestone can be found in the [issue tracker](https://github.com/thegreatfeez/accord-protocol/issues).

---

## v0.2.0 — Weighted governance

**Theme:** Transform voting from flat approval counts to per-owner weighted governance, allowing multisigs with asymmetric voting power and governance versioning.

**Targeted features:**

- Per-owner voting weights (each owner can have a distinct weight, not just a binary vote)
- Quorum weight calculation (proposals require a threshold expressed as total weight, not approval count)
- Governance versioning and migration (support upgrading flat multisigs to weighted)
- Weight history and changelog (track ownership and weight changes for audit)
- Weighted approval visibility (display cumulative weight and quorum progress on proposals)

**Acceptance criteria:**

- [ ] `initialize` and weighted `set_owner_weight` functions work correctly with per-owner weights
- [ ] `create_proposal` accepts a quorum_weight and correctly snapshots total weight at creation
- [ ] `approve` and `revoke` correctly track cumulative weight and transition proposal status based on weight
- [ ] `migrate_to_weighted_governance` migrates a flat contract to weighted (assigning weight=1 to all owners)
- [ ] `is_governance_migrated`, `get_total_weight`, and `get_owner_weight` queries work correctly
- [ ] Proposal events (`ProposalCreatedEvent`, `ProposalApprovedEvent`) include weight fields
- [ ] All contract tests pass (`stellar contract test`)
- [ ] Frontend displays cumulative weight, quorum weight, and total weight in proposal details
- [ ] Frontend lint and build pass (`npm run lint && npm run build`)
- [ ] GLOSSARY.md defines quorum weight, total weight, weighted approval, and governance version

---

## v0.3.0 — Governance and usability

**Theme:** Expand the proposal lifecycle so multisigs can govern themselves (add/remove owners, change thresholds) and make the frontend more usable for day-to-day treasury operations.

**Targeted features:**

- Owner management proposals (add and remove owners through the multisig flow)
- Threshold change proposals (adjust M-of-N requirements without redeploying)
- Revoke button in the UI so owners can withdraw approvals before execution
- Real-time event feed for proposal activity (on-chain events wired to UI notifications)
- Proposal categories and tagging (Transfer, Payroll, Grant, Ops, Other)

**Acceptance criteria:**

- [ ] `create_add_owner_proposal` and `create_remove_owner_proposal` functions are implemented and tested
- [ ] `create_change_threshold_proposal` is implemented and tested
- [ ] Revoking an approval transitions a Ready proposal back to Pending when approvals fall below threshold
- [ ] The frontend displays a Revoke button on Pending and Ready proposals for the connected owner
- [ ] Proposal categories are displayed in the dashboard and filterable
- [ ] All contract tests pass (`stellar contract test`)
- [ ] Frontend lint and build pass (`npm run lint && npm run build`)

---

## v0.3.0 — Production readiness

**Theme:** Harden the contract and frontend for mainnet-class usage with time-locked execution, comprehensive access controls, and a security audit.

**Targeted features:**

- Time-locked execution (enforce a configurable delay after threshold is met before execution is allowed)
- Per-owner spending limits (optional caps on proposal amounts per signer)
- Multi-token treasury dashboard (aggregate balances for all held tokens)
- Mobile-responsive UI
- Security audit by an independent reviewer
- SEP-55 contract build verification in CI (GitHub Actions attestation pipeline)

**Acceptance criteria:**

- [ ] Time-lock delay is configurable at initialization and enforced during execute
- [ ] Per-owner spending limits can be set and are checked on proposal creation
- [ ] The dashboard displays token balances for all tokens held by the contract
- [ ] The frontend is fully responsive on mobile viewports
- [ ] A security audit report is published in `docs/`
- [ ] CI pipeline builds, attests, and verifies the contract WASM per SEP-55
- [ ] All existing tests continue to pass

---

## v1.0.0 — Mainnet launch

**Theme:** Ship a production-grade, audited multisig treasury system ready for real funds on Stellar mainnet.

**Targeted features:**

- Mainnet deployment guide and tooling
- Upgradeable contract with multi-sig co-signed upgrades
- Full documentation suite (setup, API reference, architecture, security, deployment)
- Monitoring and alerting for on-chain proposal activity
- Community governance process for protocol changes

**Acceptance criteria:**

- [ ] Contract is deployed to Stellar mainnet and verified on the block explorer
- [ ] Deployment guide is complete and tested by at least one independent contributor
- [ ] The upgrade path (multi-sig co-signed WASM replacement) works on mainnet
- [ ] Documentation covers all contract functions, frontend workflows, and deployment steps
- [ ] No known critical or high-severity vulnerabilities remain open
- [ ] The project has at least three external contributors who have merged PRs





