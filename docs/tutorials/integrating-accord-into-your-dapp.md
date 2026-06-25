# Integrating Accord into Your dApp

### What you will build
In this tutorial, you will build a small Node.js script that reads the current proposal list and submits a new payment proposal to an Accord contract on the Stellar testnet. This guide provides the foundation for interacting with the Accord multisig contract from a standard backend or script without relying on the provided frontend.

### Prerequisites
Before you begin, ensure you have the following ready:
* **Node.js 20+** installed on your machine.
* An initialized **npm project** (`npm init -y`).
* The **`@stellar/stellar-sdk`** package installed (`npm install @stellar/stellar-sdk`).
* A deployed **Accord contract ID** on the Stellar testnet.
* A **funded testnet keypair** (the secret key of an account that is registered as an owner on the Accord contract).

---

## Reading contract state

To read data from a Soroban contract without altering its state, we simulate the transaction. This doesn't cost gas or require a signature from the contract owners. 

Here is how you simulate a call to `get_proposals_paged` to fetch a list of proposals:

```javascript
import { rpc, Contract, nativeToScVal, scValToNative, TransactionBuilder, Networks } from '@stellar/stellar-sdk';

const RPC_URL = "[https://soroban-testnet.stellar.org](https://soroban-testnet.stellar.org)";
const NETWORK_PASSPHRASE = Networks.TESTNET; 
const CONTRACT_ID = "YOUR_CONTRACT_ID";

// Any funded testnet public key can act as the simulation source
const SIM_PUBLIC_KEY = "G...ANY_FUNDED_ACCOUNT"; 

async function readProposals() {
  const server = new rpc.Server(RPC_URL);
  const account = await server.getAccount(SIM_PUBLIC_KEY);
  const contract = new Contract(CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    // get_proposals_paged(offset: u64, limit: u32)
    .addOperation(contract.call("get_proposals_paged",
      nativeToScVal(0n, { type: "u64" }),
      nativeToScVal(10, { type: "u32" })
    ))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error("Simulation failed");
  }

  const result = scValToNative(sim.result.retval);
  console.log("Proposals:", result);
}

readProposals();
```

---

## Submitting a proposal
To create a new proposal, we must call the `create_proposal` function. Since this changes the contract's state, we must authorize it with an owner's secret key, prepare the transaction, send it to the network, and continuously poll for confirmation.

```JavaScript
import { rpc, Contract, Keypair, nativeToScVal, TransactionBuilder, Networks } from '@stellar/stellar-sdk';

async function createProposal() {
  const server = new rpc.Server("[https://soroban-testnet.stellar.org](https://soroban-testnet.stellar.org)");
  const keypair = Keypair.fromSecret("YOUR_OWNER_SECRET_KEY");
  const account = await server.getAccount(keypair.publicKey());
  const contract = new Contract("YOUR_CONTRACT_ID");

  const tx = new TransactionBuilder(account, {
    fee: "1000",
    networkPassphrase: Networks.TESTNET,
  })
    // create_proposal(proposer, to, amount, token, description, deadline)
    .addOperation(contract.call("create_proposal",
      nativeToScVal(keypair.publicKey(), { type: "address" }),
      nativeToScVal("G_RECIPIENT_ADDRESS", { type: "address" }),
      nativeToScVal(10000000n, { type: "i128" }), // 1 token (in stroops)
      nativeToScVal("C_TOKEN_CONTRACT_ADDRESS", { type: "address" }),
      nativeToScVal("Marketing Q3 Payment", { type: "string" }),
      nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 86400 * 7), { type: "u64" }) // 7-day deadline
    ))
    .setTimeout(30)
    .build();

  // Prepare the transaction (simulates it to fetch footprint and fee data)
  const preparedTx = await server.prepareTransaction(tx);
  
  // Sign the prepared transaction
  preparedTx.sign(keypair);

  // Send it to the network
  const sendResponse = await server.sendTransaction(preparedTx);
  console.log("Transaction submitted. Hash:", sendResponse.hash);

  // Poll for confirmation
  let txResponse = await server.getTransaction(sendResponse.hash);
  while (txResponse.status === "NOT_FOUND") {
    console.log("Waiting for confirmation...");
    await new Promise(resolve => setTimeout(resolve, 2000));
    txResponse = await server.getTransaction(sendResponse.hash);
  }

  if (txResponse.status === "SUCCESS") {
    console.log("Proposal successfully created!");
    // Extract the returned Proposal ID from the result
    const txResultMeta = txResponse.resultMetaXdr;
    // Processing XDR to get the ID is required here, but the transaction succeeded.
  } else {
    console.error("Transaction failed:", txResponse);
  }
}

createProposal();
```

---

## Approving a proposal
Once you know the ID of an active proposal (either from the read call or event logs), you can approve it. This follows the exact same build-sign-submit pattern, but calls the contract's `approve` function (often conceptually thought of as "approve_proposal").

```JavaScript
async function approveProposal(proposalId) {
  // Setup server, keypair, and account as done in the previous step
  const tx = new TransactionBuilder(account, {
    fee: "1000",
    networkPassphrase: Networks.TESTNET,
  })
    // approve(approver, proposal_id)
    .addOperation(contract.call("approve",
      nativeToScVal(keypair.publicKey(), { type: "address" }),
      nativeToScVal(BigInt(proposalId), { type: "u64" })
    ))
    .setTimeout(30)
    .build();

  const preparedTx = await server.prepareTransaction(tx);
  preparedTx.sign(keypair);
  
  const sendResponse = await server.sendTransaction(preparedTx);
  
  // Polling loop
  let txResponse = await server.getTransaction(sendResponse.hash);
  while (txResponse.status === "NOT_FOUND") {
    await new Promise(resolve => setTimeout(resolve, 2000));
    txResponse = await server.getTransaction(sendResponse.hash);
  }

  if (txResponse.status === "SUCCESS") {
    console.log(`Proposal #${proposalId} successfully approved!`);
  }
}
```

---

## Common pitfalls
When integrating Accord into your dApp, keep these common trip-ups in mind:
- **Using the wrong network passphrase:** You must configure the `TransactionBuilder` and simulation calls with the correct passphrase (e.g., `Test SDF Network ; September 2015` for testnet). Utilizing `Networks.TESTNET` from the SDK helps avoid typos.
- **Token amounts and Stroops:** All amounts passed into `create_proposal` (and handled by Stellar generally) must be in the token's smallest unit. For XLM-derived tokens, this is stroops. 1 XLM = 10,000,000 stroops. Always multiply standard token values by `10^7` (or the token's specific decimal count) before casting them as an `i128`.
- **Owner authorization rules:** State-changing methods like `create_proposal` and `approve` can only be invoked by addresses that are registered as an owner within the Accord contract. Submitting transactions with unlisted keypairs will result in an `Unauthorized` (Error Code 3) response during simulation or execution.

---

## Next steps
Now that you can interact with the Accord multisig natively in Node.js, you can read the complete suite of functions (like `execute` and `revoke`) in our [Contract API Reference](../CONTRACT_API.md). If you haven't yet put your own contract on-chain, check out [Deploy Your Own Multisig](./deploy-your-own-multisig.md) to initialize a fresh contract for testing.