# Frequently Asked Questions

## For Users

### What is Accord Protocol?
Accord Protocol is an on-chain multisig for Stellar Soroban that lets multiple owners manage one shared treasury through proposals, approvals, and execution instead of trusting one person to hold the funds. For a broader product overview, read [README.md](../README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

### How do I connect my wallet to Accord?
Install Freighter, switch it to the same Stellar network the app expects, then click the Connect Wallet button in the Accord header and approve the connection request in the extension. For setup details and the network expectations, see [SETUP.md](./SETUP.md) and [DEPLOYMENT.md](./DEPLOYMENT.md).

### Why does Accord ask for Freighter specifically?
Accord relies on Freighter to sign Stellar transactions from the browser, so the app can read chain data without a wallet but needs Freighter for writes such as creating, approving, revoking, and executing proposals. For the wallet and signing architecture, see [ARCHITECTURE.md](./ARCHITECTURE.md) and [SETUP.md](./SETUP.md).

### Why do I need testnet funds before I can use the app?
Even on testnet, signed transactions still need an account that exists on the network and can pay the small network fees required to submit them. For the testnet funding flow and Friendbot guidance, see [SETUP.md](./SETUP.md) and [DEPLOYMENT.md](./DEPLOYMENT.md).

### How do I create a proposal?
Connect an owner wallet, open the new proposal flow in the dashboard, enter the recipient, amount, token, description, and deadline, and then sign the transaction in Freighter. For the contract rules behind proposal creation, see [CONTRACT_API.md](./CONTRACT_API.md) and [tutorials/understanding-proposal-lifecycle.md](./tutorials/understanding-proposal-lifecycle.md).

### What happens after I create a proposal?
A newly created proposal enters Pending status, stays active until it reaches the threshold or its deadline passes, and can then move to Ready, Executed, Expired, or Revoked depending on later owner actions. For the full state model, see [tutorials/understanding-proposal-lifecycle.md](./tutorials/understanding-proposal-lifecycle.md) and [CONTRACT_API.md](./CONTRACT_API.md).

### Can I approve my own proposal?
Yes, if your address is one of the configured multisig owners, you can approve a proposal you created because Accord tracks approvals by owner rather than by proposal author. For the approval rules and related errors, see [CONTRACT_API.md](./CONTRACT_API.md) and [SECURITY.md](./SECURITY.md).

### Can I change my mind after approving a proposal?
Yes, an owner can revoke their own approval while the proposal is still active, and that can move the proposal from Ready back to Pending if the approval count drops below the threshold. For that edge case and the related contract behavior, see [tutorials/understanding-proposal-lifecycle.md](./tutorials/understanding-proposal-lifecycle.md) and [CONTRACT_API.md](./CONTRACT_API.md).

### Why can a proposal show Ready and still not move funds yet?
Ready only means the proposal has enough approvals to execute; an owner still has to submit the execute transaction before funds move on-chain, and the proposal can still expire first if the deadline passes. For the execution rules and lifecycle edge cases, see [tutorials/understanding-proposal-lifecycle.md](./tutorials/understanding-proposal-lifecycle.md) and [CONTRACT_API.md](./CONTRACT_API.md).

### What should I do if my wallet is connected in read-only mode?
Read-only mode means the connected address is not part of the multisig owner set, so you can inspect data but cannot sign owner-only actions until you connect a listed signer instead. For owner-only access assumptions, see [SECURITY.md](./SECURITY.md) and [CONTRACT_API.md](./CONTRACT_API.md).

## For Developers

### What do I need installed before developing locally?
You need Git, Rust, Node.js 20, and the Stellar CLI, and you may also want Docker if you plan to run a local Soroban node. For the full environment checklist and verification steps, see [SETUP.md](./SETUP.md).

### How do I run the frontend locally?
Copy the environment template, install frontend dependencies, fill in the contract-related environment variables, and start the Vite dev server from the `frontend` directory. For the exact local setup flow, see [SETUP.md](./SETUP.md) and [DEPLOYMENT.md](./DEPLOYMENT.md).

### How do I run the contract tests?
Run the Soroban contract test command from the repository root or enter `contracts/accord` and run the Rust test suite directly there; both paths exercise the smart contract behavior before deployment. For the official setup and validation commands, see [SETUP.md](./SETUP.md).

### How do I deploy the contract to testnet?
Build the contract WASM, deploy it with the Stellar CLI, record the contract ID, and then wire that ID into the frontend environment configuration before starting the app. For the full deployment sequence, see [DEPLOYMENT.md](./DEPLOYMENT.md).

### Where do I find the contract function signatures and errors?
The most complete function-by-function reference is the contract API document, which lists the parameters, access rules, emitted events, and common errors for each public function. See [CONTRACT_API.md](./CONTRACT_API.md).

### How do I integrate another client or SDK with Accord?
Treat Accord as a Soroban contract that exposes read methods for state and write methods for owner-authorized changes, then build your client around the same proposal, approval, revoke, and execute lifecycle the web frontend uses. For the contract surface and architecture boundaries, see [CONTRACT_API.md](./CONTRACT_API.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

### What security assumptions should integrators understand before shipping?
Integrators need to assume owner keys stay secret, the chosen RPC node is honest enough to provide current state, and the token contracts involved in proposals are trustworthy. For the threat model, trust assumptions, and operator guidance, see [SECURITY.md](./SECURITY.md).

## General

### How is Accord different from a single-key treasury wallet?
A single-key wallet lets one compromised device or person move funds alone, while Accord requires multiple owners to approve a proposal before the contract will allow execution. For the problem statement and design goals, see [README.md](../README.md) and [SECURITY.md](./SECURITY.md).

### How is Accord different from a custodial multisig service?
Accord keeps the approval logic and treasury custody on-chain inside a Soroban contract, so the team does not have to trust a third-party operator to hold assets or finalize approvals for them. For the architecture and custody model, see [README.md](../README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

### What is Stellar Soroban in plain English?
Soroban is Stellar’s smart contract platform, which means it lets applications like Accord enforce shared wallet rules directly on-chain instead of relying on an off-chain database or central admin. For how Accord uses Soroban in practice, see [README.md](../README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

### Is Accord ready for mainnet funds?
No, the repository explicitly states that the contract is unaudited and should not hold meaningful mainnet funds until a formal security review is complete. For the current posture and operating cautions, see [SECURITY.md](./SECURITY.md).

### Where should contributors start if they want to help?
Start with the contributor guide, then review the setup steps, run the tests locally, and use the changelog format when preparing follow-up work for release. For contributor expectations and workflow, see [CONTRIBUTING.md](./CONTRIBUTING.md), [SETUP.md](./SETUP.md), and [../CHANGELOG.md](../CHANGELOG.md).
