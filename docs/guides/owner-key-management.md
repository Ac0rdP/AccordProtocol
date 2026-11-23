# Owner Key Management

An Accord owner key is a treasury-control credential. Protect each key as if
it were a root credential: a stolen key can approve proposals, participate in
owner-management changes, and contribute its configured voting weight until the
owner is removed on-chain.

This guide covers operational key storage, hardware-wallet use, and the safe
replacement of an owner. It assumes the current Accord model: owners have
individual weights, proposals use a threshold measured in total weight, and
operational roles can further restrict who may propose, approve, or execute.

## Recommended storage

For every owner:

- Use a dedicated hardware wallet or other offline signing device for the
  owner key whenever the wallet integration and network support it.
- Keep the device PIN, recovery phrase, and any backup separately. Do not put
  the recovery phrase in email, chat, screenshots, cloud notes, source code,
  `.env` files, or a shared team password manager.
- Store at least one recovery backup offline in a physically secure location.
  Use an appropriate durable backup for the recovery phrase, and limit who can
  access it.
- Use a dedicated browser profile or workstation for signing. Keep the wallet
  software, browser, device firmware, and operating system up to date.
- Never share a seed phrase or private key with another owner, an operator, a
  support person, or a website. A multisig distributes approval authority; it
  does not make shared private keys safe.
- Maintain a written inventory of the owner address, assigned person or team,
  voting weight, roles, backup location, and last verification date. The
  inventory must not contain the private key or recovery phrase.

Use a separate low-value account for experimentation. Do not test a new wallet
or signing flow with a production owner key or a production treasury.

## Using a hardware wallet

1. Confirm that the device is genuine, initialized by you, and showing the
   expected account address. Record only the public address in the Accord
   owner inventory.
2. Connect through the approved wallet application and verify the network
   before signing. Testnet and mainnet addresses and transactions must never
   be mixed.
3. Open the Accord dashboard from the team's known bookmark or a verified
   repository link. Do not follow wallet links from unsolicited messages.
4. Before approving or executing, compare the transaction on the device screen
   with the dashboard and the proposal: contract address, token, amount,
   recipient, proposal ID, and network. Reject anything that is missing,
   truncated, or different.
5. Sign only the transaction you intended. A successful simulation or a
   familiar-looking website is not a substitute for checking the device's
   confirmation screen.
6. Verify the submitted transaction and resulting contract state using the
   dashboard and an independent explorer or RPC read. For an approval, check
   the proposal's approval weight; for execution, check the proposal status
   and treasury balance.

Do not enter a hardware-wallet recovery phrase into a browser, wallet-connect
prompt, support form, or command-line tool. A request to “synchronize,” “fix,”
or “validate” a seed phrase is a phishing attempt.

## Understand what the key can do

The configured threshold is an absolute voting-weight requirement. For
example, weights `[5, 3, 2]` with threshold `6` require 6 weight units; this is
not necessarily three owners. A single owner whose weight reaches the
threshold can act alone, so review the distribution as well as the threshold.

Accord's default owner setup grants each owner Proposer, Approver, and
Executor roles. Roles can be narrowed later, but roles do not replace owner
authorization:

- `Approver` is required to approve or revoke, and the caller must also be an
  owner whose weight is counted.
- `Proposer` permits proposal creation, including owner, weight, threshold, and
  role changes. Guardian changes are separate owner-weight-authorized calls.
- `Executor` permits execution of a proposal that has reached Ready and
  cleanup of expired proposals. An executor does not change proposal terms.
- `Viewer` is observational and does not grant write authority.

Keep approval weight available. Before removing an owner or revoking an
owner's `Approver` role, confirm that the remaining eligible approver weight
can still reach the current threshold and can satisfy every active proposal's
snapshotted quorum. A role-only change can strand the proposal pipeline even
when the owner list itself is still intact.

## Owner rotation and handover

Plan a replacement while the departing owner is still available and no key is
known to be compromised. Use the following sequence:

1. **Prepare the successor.** The successor creates and verifies a fresh
   wallet, preferably on a hardware device. Confirm the public address through
   a second channel and document the intended weight and roles. Never ask the
   successor for a seed phrase.
2. **Review quorum safety.** Check current owner weights, total weight,
   threshold, active proposals, and Approver-role weight. Decide whether the
   replacement should keep the same weight and roles. Do not combine several
   owner removals, threshold changes, or weight changes without sequencing
   them; their creation-time checks do not protect against every combined
   execution outcome.
3. **Add the successor first.** A proposer creates an `AddOwner` proposal with
   the successor address and weight. Existing eligible owners review the
   exact address and approve it until the required quorum weight is reached.
   An executor then executes it.
4. **Verify on-chain state.** Confirm the successor is an owner, the assigned
   weight and roles are correct, and the total weight and threshold remain
   reachable. Have the successor sign a low-risk test transaction or approval
   according to the team's runbook; do not use a treasury transfer as the test.
5. **Remove the departing owner.** Create a `RemoveOwner` proposal for the
   old address only after the successor is confirmed. Collect quorum and
   execute it. Removing an owner is not the same as destroying the old key;
   securely retire or wipe the old device and revoke any local wallet access
   after the on-chain removal is confirmed.
6. **Update the handover record.** Record the new owner address, weight, roles,
   device custodian, recovery location, and verification date. Remove the
   departing person's access to dashboards, shared operational accounts, and
   notification channels, while preserving the audit trail.

If the transition also needs a threshold or weight change, execute and verify
one governance change before creating the next dependent proposal. The
threshold stored on an existing proposal is snapshotted when that proposal is
created, so a later threshold change does not rewrite it.

### Emergency rotation after compromise or loss

Treat a lost, exposed, or phished key as compromised immediately. If a
guardian is configured, the guardian can call `freeze` to block new proposal
creation and execution while the remaining owners investigate. Then:

1. Confirm which address was exposed and review pending and recently executed
   proposals.
2. Have the remaining uncompromised owners create, approve, and execute a
   `RemoveOwner` proposal as quickly as quorum allows.
3. Add a replacement owner and restore the intended threshold and role layout.
4. Re-check all active proposals, treasury balances, guardian state, and
   explorer history before unfreezing.
5. Call `unfreeze` only with distinct registered owners whose combined weight
   reaches the threshold.

If the remaining owners cannot reach quorum, Accord has no automatic recovery
path. Do not attempt to “recover” the account by importing the exposed seed
into another browser wallet; coordinate an incident response and preserve the
evidence.

## Guardian and threshold configuration

A guardian is an emergency pause address, not an owner and not a treasury
signer. Setting or replacing the guardian requires distinct registered owners
whose combined weight reaches the current threshold. The guardian alone can
call `freeze`, which blocks new proposals and execution, but cannot approve,
execute, remove owners, change the threshold, or unfreeze the contract.

Resuming after a freeze requires `unfreeze` with distinct owner co-signers
whose combined weight reaches the threshold. Store the guardian key with the
same care as an operational security key, but keep its custodian independent
from the owner keys when possible. A guardian should be reachable during an
incident without becoming a single party that controls treasury funds.

Review this configuration whenever owners, weights, roles, or the value of the
treasury changes. The practical safety invariant is:

> The remaining eligible approvers must have enough combined weight to reach
> the threshold, while no unintended single owner or coalition has excessive
> control.

## Phishing and signing warnings

Common attacks include fake wallet updates, fake support staff, a cloned
dashboard, QR codes sent through chat, malicious browser extensions, and
“airdrop” or “verification” pages requesting a seed phrase. Treat urgent
requests, unexpected direct messages, and promises of recovery as hostile.

Before every signature:

- open the application from a saved, verified URL;
- confirm the network and contract address;
- compare the full recipient, token, amount, proposal ID, and action on the
  hardware device;
- ask a second owner to independently review high-value or governance
  transactions; and
- stop if the wallet requests a seed phrase, an unexplained permission, or a
  transaction that does not match the proposal.

Report suspected compromise to the team's incident channel without posting
secrets. Freeze first when a configured guardian can safely do so, then follow
the emergency rotation procedure above.

## Related documentation

- [Setting Up a Team Multisig](team-multisig.md)
- [Choosing Voting Weights](weighted-governance.md)
- [Roles & Permissions](roles-and-permissions.md)
- [Security Policy](../SECURITY.md)
- [Contract API Reference](../CONTRACT_API.md)
