# Accord Protocol

[![Contract CI](https://github.com/thegreatfeez/accord-protocol/actions/workflows/ci-contract.yml/badge.svg)](https://github.com/thegreatfeez/accord-protocol/actions/workflows/ci-contract.yml)
[![Lint & Format](https://github.com/thegreatfeez/accord-protocol/actions/workflows/ci-lint.yml/badge.svg)](https://github.com/thegreatfeez/accord-protocol/actions/workflows/ci-lint.yml)
[![Frontend CI](https://github.com/thegreatfeez/accord-protocol/actions/workflows/ci-frontend.yml/badge.svg)](https://github.com/thegreatfeez/accord-protocol/actions/workflows/ci-frontend.yml)
![Soroban](https://img.shields.io/badge/Built%20on-Soroban-blue)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
<!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-1-orange.svg?style=flat-square)](#contributors-)
<!-- ALL-CONTRIBUTORS-BADGE:END -->

**M-of-N multisig treasury management on Stellar Soroban — no trusted intermediaries, no single points of failure.**

---

## The Problem

Shared crypto treasuries are hard to manage safely. Most teams resort to one of three bad options:

- **Single-key wallets** — one person controls everything. One compromise = total loss.
- **Centralised services** — custody handed to a third party. You trust them, not code.
- **Complex L1 multisigs** — expensive gas, slow UX, inaccessible to non-technical co-owners.

Accord is a fourth option: a lightweight, fully on-chain multisig built on Stellar Soroban. Every proposal, approval, and execution is recorded on-chain and verifiable by anyone. The contract holds the funds — no one person does.

---

## What Accord Does

Any group of co-owners can deploy Accord and manage a shared treasury with configurable M-of-N approval rules. The full lifecycle — from creating a payment proposal to executing the transfer — happens on-chain and through a clean web interface.

```
Owner A creates a proposal → Owner B & C approve → threshold met → any owner executes
```

**Key properties:**

- **Threshold-based approvals** — set any M-of-N rule (e.g. 2-of-3, 3-of-5)
- **Proposal lifecycle** — `Pending → Ready → Executed | Expired | Revoked`
- **Any Stellar token** — XLM, USDC, EURC, or any SEP-41 compatible token
- **Deadline enforcement** — proposals auto-expire on-chain, no manual cleanup needed
- **Upgradeable contract** — code can be improved without losing state or changing the contract ID
- **Zero trusted intermediaries** — the contract is the only custodian

---

## Live Deployment (Testnet)

| | |
|---|---|
| **Contract ID** | `CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS` |
| **Network** | Stellar Testnet |
| **Explorer** | [View on Stellar Expert](https://stellar.expert/explorer/testnet/contract/CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS) |
| **Frontend** | [accord-protocol.vercel.app](https://accord-protocol.vercel.app/) |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (React + Vite)                │
│                                                         │
│  ┌──────────────┐    ┌──────────────────────────────┐  │
│  │  Freighter   │    │   Read-only simulation calls  │  │
│  │   Wallet     │    │   (no signing required)       │  │
│  └──────┬───────┘    └──────────────┬───────────────┘  │
│         │ sign tx                   │ simulateTransaction│
└─────────┼───────────────────────────┼───────────────────┘
          │                           │
          ▼                           ▼
   Soroban RPC (testnet.stellar.org)
          │
          ▼
   ┌──────────────────────┐
   │   accord contract    │
   │  (Rust / Soroban SDK)│
   │                      │
   │  - Instance storage  │
   │    owners, threshold │
   │  - Persistent storage│
   │    proposals,        │
   │    approvals         │
   └──────────────────────┘
```

Read calls use `simulateTransaction` — no wallet needed, no fees. Write calls (approve, execute, create) go through Freighter for signing and are submitted to the network.

Full details: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

---

## Repository Layout

```
contracts/accord/        Soroban smart contract (Rust)
  src/lib.rs             Contract logic — proposals, approvals, execution
  src/test.rs            29 unit tests covering all lifecycle paths

frontend/
  src/lib/contract.ts    Read-only Soroban RPC calls
  src/lib/submit.ts      Signed transaction builder and submitter
  src/lib/wallet.ts      Freighter wallet integration
  src/hooks/             useContract (live data), useWallet (wallet state)
  src/pages/             Dashboard and History views
  src/components/        ProposalCard, StatCard, CreateProposalModal, etc.

scripts/
  deploy.sh              Build, upload WASM, deploy contract

docs/                    Setup, architecture, API reference, security, deployment

.github/workflows/       CI: contract tests, frontend build, lint — run on every PR
```

---

## Getting Started

> **New contributors:** See [`docs/SETUP.md`](./docs/SETUP.md) for full environment setup on macOS, Linux, and Windows (WSL2).

### 1. Clone and install

```bash
git clone https://github.com/thegreatfeez/accord-protocol.git
cd accord-protocol
cp frontend/.env.example frontend/.env.local
cd frontend && npm ci
```

### 2. Fill in your `.env.local`

```env
VITE_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
VITE_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
VITE_CONTRACT_ADDRESS=CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS
VITE_SIM_SOURCE=<any funded testnet public key>
```

`VITE_SIM_SOURCE` is just a funded testnet key used to build simulation transactions — it never signs anything. Get a free testnet account at [Friendbot](https://friendbot.stellar.org).

### 3. Run the frontend

```bash
npm run dev
```

### 4. Run the contract tests

```bash
cd contracts/accord && cargo test
# 29 tests, all should pass
```

---

## Contract Functions

| Function | Who can call | What it does |
|---|---|---|
| `initialize(owners, threshold)` | Anyone (once) | Sets up the multisig — owners list and M-of-N threshold |
| `create_proposal(proposer, to, amount, token, description, deadline)` | Owners only | Creates a new transfer proposal |
| `approve(approver, proposal_id)` | Owners only | Adds approval; auto-transitions to `Ready` at threshold |
| `revoke(approver, proposal_id)` | Owners only | Removes approval; transitions back to `Pending` if needed |
| `execute(executor, proposal_id)` | Owners only | Transfers tokens on-chain when proposal is `Ready` |
| `upgrade(caller, new_wasm_hash)` | Owners only | Replaces contract code in-place — state and contract ID preserved |
| `get_proposal(id)` | Anyone | Returns proposal with derived status |
| `get_proposals_paged(offset, limit)` | Anyone | Paginated proposal list |
| `get_owners()` | Anyone | Returns current owner list |
| `get_threshold()` | Anyone | Returns current threshold |
| `is_owner(address)` | Anyone | Checks if an address is an owner |
| `has_approved(proposal_id, owner)` | Anyone | Checks if an owner has approved a specific proposal |

Full API reference: [`docs/CONTRACT_API.md`](./docs/CONTRACT_API.md)

---

## Common Commands

| Task | Command |
|---|---|
| Run contract tests | `cd contracts/accord && cargo test` |
| Check contract formatting | `cd contracts/accord && cargo fmt --check` |
| Lint contract | `cd contracts/accord && cargo clippy -- -D warnings` |
| Build WASM | `stellar contract build` |
| Deploy contract | `bash scripts/deploy.sh` |
| Run frontend dev server | `cd frontend && npm run dev` |
| Build frontend | `cd frontend && npm run build` |
| Lint frontend | `cd frontend && npm run lint` |

---

## Roadmap

### Near-term
- [ ] Real-time event feed for proposal activity (on-chain events → UI notifications)
- [ ] Owner management proposals (add/remove owner via the proposal flow)
- [ ] Revoke button in the UI

### Mid-term
- [ ] Multi-token treasury dashboard (aggregate balances for all held tokens)
- [ ] Time-locked execution (enforce a delay after threshold is met)
- [ ] Mobile-responsive UI

### Long-term
- [ ] Per-owner spending limits
- [ ] Proposal categories and tagging
- [ ] Mainnet deployment guide

---

## Contributing

Accord is an open-source project and welcomes contributions of all kinds — contract logic, frontend features, tests, documentation, and bug fixes.

**Start here:** [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md)

The guide covers:
- Branch naming and commit style
- How to open a pull request
- CI checks that must pass
- How the contract upgrade flow works for merged changes

---

## Contributors

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/thegreatfeez"><img src="https://avatars.githubusercontent.com/u/thegreatfeez?v=4?s=100" width="100px;" alt="thegreatfeez"/><br /><sub><b>thegreatfeez</b></sub></a><br /><a href="#code" title="Code">💻</a> <a href="#doc" title="Documentation">📖</a> <a href="#ideas" title="Ideas, Planning, & Feedback">🤔</a></td>
    </tr>
  </tbody>
</table>
<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind welcome!

---

## Security

This contract is **unaudited**. Do not use on mainnet with significant funds until a formal security audit is completed.

Found a vulnerability? See [`docs/SECURITY.md`](./docs/SECURITY.md) for responsible disclosure guidelines.

---

## License

MIT — see [LICENSE](./LICENSE)

## Recent Changes
- Ongoing improvements and fixes as part of active development.
- See commit history and open issues for detailed change tracking.
