import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

const SECTIONS = [
  { id: "what-is-accord", label: "What is Accord?" },
  { id: "getting-started", label: "Getting Started" },
  { id: "proposal-lifecycle", label: "Proposal Lifecycle" },
  { id: "approving-and-executing", label: "Approving & Executing" },
  { id: "creating-a-proposal", label: "Creating a Proposal" },
  { id: "owners-and-threshold", label: "Owners & Threshold" },
  { id: "faq", label: "FAQ" },
] as const;

export function DocsPage() {
  const [activeSection, setActiveSection] =
    useState<(typeof SECTIONS)[number]["id"]>("what-is-accord");
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const filteredSections = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return normalizedQuery
      ? SECTIONS.filter((section) =>
          section.label.toLowerCase().includes(normalizedQuery),
        )
      : SECTIONS;
  }, [searchQuery]);

  const handleSidebarNav = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  useEffect(() => {
    const headings = SECTIONS.map(({ id }) =>
      document.getElementById(id),
    ).filter((element): element is HTMLElement => Boolean(element));

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleEntry = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (left, right) => right.intersectionRatio - left.intersectionRatio,
          )[0];

        if (visibleEntry) {
          setActiveSection(
            visibleEntry.target.id as (typeof SECTIONS)[number]["id"],
          );
        }
      },
      {
        rootMargin: "-20% 0px -60% 0px",
        threshold: [0.1, 0.3, 0.6],
      },
    );

    headings.forEach((heading) => observer.observe(heading));

    return () => {
      observer.disconnect();
      setSearchQuery("");
    };
  }, []);

  const activeLabel =
    SECTIONS.find((s) => s.id === activeSection)?.label ?? "";

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <header className="border-b border-zinc-900 px-6 py-5">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <Link
            to="/"
            className="flex items-center gap-3 transition-opacity hover:opacity-80"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500 text-sm font-bold text-black">
              A
            </div>
            <div>
              <p className="text-sm font-semibold tracking-tight">
                Accord Docs
              </p>
              <p className="text-xs text-zinc-500">
                Testnet setup and operating guide
              </p>
            </div>
          </Link>

          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="rounded-lg border border-zinc-800 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-700 hover:text-white"
            >
              Home
            </Link>
            <Link
              to="/app"
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
            >
              Launch App
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl items-center gap-3 border-b border-zinc-900 px-6 py-3">
        <button
          type="button"
          onClick={() => setSidebarOpen((prev) => !prev)}
          className="rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:border-zinc-700 hover:text-white lg:hidden"
        >
          {sidebarOpen ? "Close" : "Menu"}
        </button>
        <nav className="flex items-center gap-2 text-sm text-zinc-500">
          <Link to="/docs" className="hover:text-zinc-300 transition-colors">
            Docs
          </Link>
          <span className="text-zinc-700">/</span>
          <span className="text-zinc-300">{activeLabel}</span>
        </nav>
      </div>

      <main className="mx-auto grid max-w-6xl gap-10 px-6 py-10 lg:grid-cols-[240px_minmax(0,1fr)]">
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/60 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <aside
          className={`fixed top-0 left-0 z-50 h-full w-72 overflow-y-auto border-r border-zinc-900 bg-zinc-950 p-6 transition-transform duration-200 lg:static lg:z-auto lg:h-auto lg:w-auto lg:border-r-0 lg:bg-transparent lg:p-0 lg:transition-none ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          } lg:translate-x-0 lg:sticky lg:top-8 lg:self-start`}
        >
          <div className="rounded-2xl border border-zinc-900 bg-zinc-950/80 p-4 lg:bg-transparent lg:border-0 lg:p-0">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.25em] text-zinc-600">
              On this page
            </p>
            <label
              className="mb-4 block text-sm text-zinc-400"
              htmlFor="docs-search"
            >
              Search sections
            </label>
            <input
              id="docs-search"
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Filter sections"
              className="mb-4 w-full rounded-2xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none transition-colors focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
            />
            <nav className="space-y-1">
              {filteredSections.map((section) => (
                <a
                  key={section.id}
                  href={`#${section.id}`}
                  onClick={handleSidebarNav}
                  className={`block rounded-xl px-3 py-2 text-sm transition-colors ${
                    activeSection === section.id
                      ? "bg-emerald-500/10 text-emerald-300"
                      : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                  }`}
                >
                  {section.label}
                </a>
              ))}
            </nav>
          </div>
        </aside>

        <div className="space-y-12">
          <section
            id="what-is-accord"
            className="scroll-mt-24 rounded-3xl border border-zinc-900 bg-zinc-950 p-8"
          >
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.25em] text-emerald-400">
              Overview
            </p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              What is Accord Protocol?
            </h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-zinc-300 sm:text-base">
              Accord is an on-chain multisig built on Stellar Soroban that lets
              a group of owners manage a shared treasury together. Instead of
              relying on a single person to hold funds, proposals are created
              directly on the blockchain, other owners approve them, and once the
              required number of approvals is reached any owner can execute the
              proposal to carry it out.
            </p>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-zinc-400 sm:text-base">
              Single-key wallets are convenient but risky: if one device is
              compromised the attacker can drain the entire treasury alone.
              Accord solves this by requiring a minimum number of owners to
              approve a proposal before the contract allows any funds or
              configuration changes to move. No single owner can act alone, so a
              lost or stolen key does not automatically mean lost assets.
            </p>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-zinc-400 sm:text-base">
              At a high level the contract stores a threshold — for example
              three of five owners. Each time an owner approves a proposal the
              approval counter increments. When the counter meets or exceeds the
              threshold the proposal becomes Ready and any single owner can
              submit the execute transaction. The contract itself holds custody
              of the funds and enforces these rules, so trust is placed in
              auditable on-chain code rather than in any individual signer.
            </p>
          </section>

          <section
            id="getting-started"
            className="scroll-mt-24 rounded-3xl border border-zinc-900 bg-zinc-950 p-8"
          >
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.25em] text-emerald-400">
              Getting Started
            </p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Before you interact with Accord
            </h2>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-zinc-400 sm:text-base">
              New users only need four things in place before the dashboard
              becomes useful: a Freighter wallet, the correct Stellar network
              selected in that wallet, a funded testnet account, and an approved
              wallet connection to the app.
            </p>

            <div className="mt-8 space-y-8">
              <div>
                <h3 className="text-xl font-semibold text-white">
                  Install Freighter
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  Freighter is the browser extension wallet Accord uses to sign
                  Stellar transactions. Install it from{" "}
                  <a
                    href="https://www.freighter.app"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-300 underline decoration-emerald-500/40 underline-offset-4"
                  >
                    freighter.app
                  </a>
                  , then open the extension and either create a new account or
                  import an existing one. Once that is done, Freighter becomes
                  the place where you approve every proposal, revoke, and
                  execute action initiated from Accord.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">
                  Switch to Testnet
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  Accord currently runs on Stellar testnet, so open Freighter,
                  go to its network settings, and switch the extension to
                  Testnet or Futurenet if that is the network your deployment is
                  using. After switching, it is normal to see different balances
                  than your main account because testnet funds are separate and
                  have no real-world value.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">
                  Fund Your Wallet with Friendbot
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  Friendbot is the Stellar faucet that sends free testnet XLM to
                  a public key so you can pay fees and sign test transactions.
                  Copy your Freighter testnet public key into the Friendbot web
                  form, request funds, and wait for the wallet to show the
                  updated balance. After funding, the same testnet balance
                  should also appear anywhere in Accord that reads your
                  connected account state.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">
                  Connect to Accord
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  When you open Accord, click the Connect Wallet button in the
                  header and approve the connection request inside Freighter.
                  After approval, the header replaces the button with a
                  shortened address such as the first six and last four
                  characters of your public key. That truncated display is only
                  a visual shortcut; the app still uses the full Stellar address
                  behind the scenes.
                </p>
              </div>
            </div>
          </section>

          <section
            id="proposal-lifecycle"
            className="scroll-mt-24 rounded-3xl border border-zinc-900 bg-zinc-950 p-8"
          >
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.25em] text-emerald-400">
              Lifecycle
            </p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Proposal Lifecycle
            </h2>
            <p className="mt-4 text-sm leading-7 text-zinc-400 sm:text-base">
              Every proposal follows a lifecycle of five possible states. A
              proposal starts as Pending when it is first created, moves to Ready
              once enough owners have approved it, and ends as Executed, Expired,
              or Revoked depending on what happens next. Owners can also revoke
              an approval at any time while the proposal is still active, which
              can move a Ready proposal back to Pending if the count drops below
              the threshold.
            </p>

            <div className="mt-8 space-y-8">
              <div>
                <h3 className="text-xl font-semibold text-white">Pending</h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  This is the initial state when a proposal is first created on
                  chain. The approval count is below the required threshold, so
                  the proposal cannot be executed yet. Owners may approve the
                  proposal to increment the counter, or revoke a previous
                  approval if they have already approved it. A Pending proposal
                  transitions to Ready once approvals meet or exceed the
                  threshold, or to Expired if the deadline passes before that
                  happens.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">Ready</h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  The approval threshold has been reached. Any single owner can
                  now submit the execute transaction to carry out the proposal.
                  Owners may still approve or revoke while the proposal remains
                  in this state. If enough revocations bring the approval count
                  back below the threshold the proposal drops back to Pending.
                  A time-lock delay may also apply, meaning execution is blocked
                  until a configurable waiting period has passed since the
                  proposal first became Ready. A Ready proposal transitions to
                  Executed on successful execution, Revoked if all approvals are
                  withdrawn, or Expired if the deadline passes.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">Executed</h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  The proposal has been carried out on chain. The contract
                  performed the action specified in the proposal, whether that is
                  a token transfer, adding or removing an owner, or changing the
                  approval threshold. Executed is a terminal state — no further
                  approvals, revocations, or executions can be submitted against
                  it.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">Expired</h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  The proposal's deadline has passed without enough approvals to
                  reach the threshold or without being executed. Expired is
                  computed at read time — the contract compares the current
                  ledger timestamp against the proposal deadline on every read
                  and automatically applies the Expired status once the deadline
                  has passed. No separate on-chain transaction is needed to
                  expire a proposal. Once expired, no approvals or executions are
                  accepted.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">Revoked</h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  An owner has explicitly revoked their approval from the
                  proposal, reducing the approval count. Revoked is a terminal
                  state that indicates the proposal was cancelled by its
                  participants rather than by an expired deadline. No further
                  actions can be submitted against a Revoked proposal.
                </p>
              </div>
            </div>
          </section>

          <section
            id="creating-a-proposal"
            className="scroll-mt-24 rounded-3xl border border-zinc-900 bg-zinc-950 p-8"
          >
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.25em] text-emerald-400">
              Guide
            </p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Creating a Proposal
            </h2>
            <p className="mt-4 text-sm leading-7 text-zinc-400 sm:text-base">
              Proposals are the core unit of work in Accord. This section walks
              through the form fields, how token amounts are handled, and what
              happens from the moment you click Submit until the new proposal
              appears in the dashboard.
            </p>

            <div className="mt-8 space-y-8">
              <div>
                <h3 className="text-xl font-semibold text-white">
                  Opening the Form
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  Click the New Proposal button in the dashboard to open a modal
                  overlay on top of the current view. You must have a Freighter
                  wallet connected before you can submit — the Submit button is
                  disabled when no wallet is detected. The form opens with the
                  recipient field focused and the deadline pre-filled to seven
                  days from today. You can press Escape or click the close icon
                  at any time to dismiss the modal without creating a proposal.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">
                  Filling in the Fields
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  The form contains four required fields that describe what the
                  proposal will do on chain.
                </p>

                <div className="mt-6 space-y-6">
                  <div className="ml-4 border-l-2 border-zinc-800 pl-4">
                    <h4 className="text-base font-semibold text-zinc-200">
                      Recipient Address
                    </h4>
                    <p className="mt-2 text-sm leading-7 text-zinc-400 sm:text-base">
                      A Stellar public key in G-address format (for example
                      starting with G followed by 55 alphanumeric characters).
                      This is the account that will receive the tokens if the
                      proposal is executed. The app validates the address in real
                      time — if the format is not a valid Ed25519 public key an
                      inline error appears below the field.
                    </p>
                  </div>

                  <div className="ml-4 border-l-2 border-zinc-800 pl-4">
                    <h4 className="text-base font-semibold text-zinc-200">
                      Amount
                    </h4>
                    <p className="mt-2 text-sm leading-7 text-zinc-400 sm:text-base">
                      The number of tokens to transfer, entered in
                      human-readable units such as 10 or 0.5 — not in stroops.
                      Internally the app converts the value to stroops (where 1
                      XLM equals 10,000,000 stroops) before building the on-chain
                      transaction, so you never need to handle the low-level unit
                      yourself. The field accepts decimals and must be greater
                      than zero.
                    </p>
                  </div>

                  <div className="ml-4 border-l-2 border-zinc-800 pl-4">
                    <h4 className="text-base font-semibold text-zinc-200">
                      Token
                    </h4>
                    <p className="mt-2 text-sm leading-7 text-zinc-400 sm:text-base">
                      A row of three toggle buttons lets you pick one of XLM,
                      USDC, or EURC. XLM is selected by default. Each button
                      highlights in green when active. The chosen token
                      determines which Stellar asset contract the proposal will
                      transfer from the multisig treasury.
                    </p>
                  </div>

                  <div className="ml-4 border-l-2 border-zinc-800 pl-4">
                    <h4 className="text-base font-semibold text-zinc-200">
                      Description
                    </h4>
                    <p className="mt-2 text-sm leading-7 text-zinc-400 sm:text-base">
                      A short, human-readable note explaining what the payment
                      is for. This text is stored on chain alongside the proposal
                      and is visible to all owners when they review it in the
                      dashboard, so it should be clear enough that another signer
                      can understand the intent without asking.
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">
                  Deadline and Fees
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  The deadline field is a date picker that defaults to seven days
                  from today. The contract enforces that the deadline must be in
                  the future and cannot be more than 90 days away. Once the
                  deadline passes, the proposal automatically expires and no
                  further approvals or executions will be accepted.
                </p>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  Before you sign, Freighter displays the estimated network fee
                  for the transaction. You can also click the Calculate fee
                  button inside the form to get a more precise estimate before
                  submitting. The fee is paid in XLM from your connected wallet
                  and is separate from the proposal amount itself.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">
                  After You Submit
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  Clicking Submit Proposal triggers the Freighter signing prompt.
                  Review the transaction details in the extension popup and
                  approve it to broadcast the transaction to the Stellar
                  network. While the transaction is in flight the submit button
                  changes to a Submitting state and the dashboard displays a
                  Waiting for confirmation banner at the top of the page.
                </p>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  Once the network confirms the transaction the modal closes, the
                  banner disappears, and the dashboard refreshes with the latest
                  on-chain state. The new proposal appears in the Active
                  Proposals list with a Pending status, ready for other owners to
                  review and approve.
                </p>
              </div>
            </div>
          </section>

          <section
            id="owners-and-threshold"
            className="scroll-mt-24 rounded-3xl border border-zinc-900 bg-zinc-950 p-8"
          >
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.25em] text-emerald-400">
              Governance
            </p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Owners & Threshold
            </h2>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-zinc-400 sm:text-base">
              The multisig owner list and the approval threshold are the two core
              configuration values that determine who can act on the treasury and
              how much consensus is needed. They are set once at deployment and
              can be changed afterward through governance proposals.
            </p>

            <div className="mt-8 space-y-8">
              <div>
                <h3 className="text-xl font-semibold text-white">
                  What Is M-of-N?
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  Accord uses an M-of-N multisig model. M is the threshold — the
                  minimum number of owner approvals required before a proposal can
                  be executed. N is the total number of owners registered in the
                  contract. For example, in a 3-of-5 setup, five owners are
                  registered and any three of them must approve a proposal before
                  it becomes executable. The threshold must always be at least
                  one and cannot exceed the total number of owners.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">
                  Viewing Owners
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  The Owners page in the dashboard lists every current owner
                  address along with the configured threshold. You do not need to
                  connect a wallet to view this information — the page reads
                  directly from the on-chain contract state. This makes it easy
                  for any visitor to verify who is part of the multisig before
                  interacting with a proposal.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">
                  Adding an Owner
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  Adding a new owner is a governance action that goes through the
                  standard proposal flow. An existing owner creates an add-owner
                  proposal specifying the new address. The proposal follows the
                  same lifecycle as a transfer — it starts as Pending, collects
                  approvals from other owners, and becomes Ready once the
                  threshold is met. When any owner executes the proposal, the
                  new address is added to the on-chain owner list and gains
                  approval rights for future proposals. The contract enforces a
                  maximum of 20 owners and rejects proposals that try to add a
                  duplicate address.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">
                  Removing an Owner
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  Removing an owner follows the same proposal-based flow. An
                  existing owner creates a remove-owner proposal targeting the
                  address to be removed. Once approved and executed, the address
                  is dropped from the owner list and can no longer approve or
                  execute proposals. There is one important constraint: you
                  cannot remove an owner if doing so would leave the remaining
                  owner count below the current threshold. For example, if the
                  threshold is 3 and there are exactly 3 owners, you must lower
                  the threshold before any owner can be removed.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">
                  Changing the Threshold
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  The approval threshold can be raised or lowered through a
                  change-threshold proposal. The new value must be at least 1
                  and cannot exceed the current number of owners. Like every
                  other governance action, the proposal must collect the
                  required number of approvals from existing owners before it
                  can be executed. This lets the group tighten or loosen the
                  consensus requirement as the team evolves — for instance,
                  lowering the threshold after an owner is removed, or raising
                  it when a new owner joins.
                </p>
              </div>
            </div>
          </section>

          <section
            id="approving-and-executing"
            className="scroll-mt-24 rounded-3xl border border-zinc-900 bg-zinc-950 p-8"
          >
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.25em] text-emerald-400">
              Governance
            </p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Approving &amp; Executing
            </h2>
            <p className="mt-4 text-sm leading-7 text-zinc-400 sm:text-base">
              Once a proposal exists on-chain, the multisig owners review it and
              decide whether to approve. When enough owners approve, the proposal
              becomes executable. This section explains who can take these actions,
              how the threshold mechanism works, and what happens during and after
              execution.
            </p>

            <div className="mt-8 space-y-8">
              <div>
                <h3 className="text-xl font-semibold text-white">
                  Who Can Approve
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  Only addresses that are part of the multisig owners list can
                  approve, revoke, or execute proposals. The contract checks the
                  caller's authorization against the stored owners on every
                  action. If your address is not in the owners list, the dashboard
                  displays a read-only view of the proposals — you can observe
                  the multisig activity but cannot sign or submit transactions.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">
                  How the Threshold Works
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  Each owner may add exactly one approval per proposal. The
                  approval count is stored on-chain and compared against the
                  configured threshold — for example, a 2-of-3 multisig requires
                  two approvals before a proposal is ready. The moment the
                  approval count reaches the threshold, the proposal status
                  automatically transitions from Pending to Ready.
                </p>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  If an owner revokes their approval after the threshold has been
                  reached and the count drops back below the threshold, the
                  proposal status returns to Pending. This means the multisig can
                  reconsider a proposal before execution as long as no owner has
                  already executed it.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">
                  Executing a Proposal
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  Any multisig owner can press Execute once a proposal has reached
                  the Ready state. When executed, the contract transfers tokens
                  directly from the multisig account to the recipient address
                  specified in the proposal. For governance proposals — such as
                  adding or removing an owner, or changing the threshold — the
                  corresponding state change is applied instead of a token
                  transfer.
                </p>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  Execution is blocked if the proposal deadline has already passed.
                  Expired proposals cannot be executed; they must be replaced with
                  a new proposal if the action is still needed.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-white">
                  After Execution
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">
                  Once execution succeeds, the proposal moves to Executed status
                  and is removed from the active list on the dashboard. You can
                  find executed proposals in the history view, where the full
                  lifecycle — who proposed it, who approved, and when it was
                  executed — remains visible for audit purposes.
                </p>
              </div>
            </div>
          </section>

          <section
            id="faq"
            className="scroll-mt-24 rounded-3xl border border-zinc-900 bg-zinc-950 p-8"
          >
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.25em] text-emerald-400">
              Reference
            </p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              FAQ
            </h2>
            <p className="mt-4 text-sm leading-7 text-zinc-400 sm:text-base">
              Answers to the most common questions about using Accord Protocol.
            </p>

            <div className="mt-8 space-y-8">
              <div>
                <h3 className="text-lg font-semibold text-white">
                  How do I connect my wallet to Accord?
                </h3>
                <p className="mt-2 text-sm leading-7 text-zinc-400 sm:text-base">
                  Install Freighter, switch it to the same Stellar network the
                  app expects, then click the Connect Wallet button in the Accord
                  header and approve the connection request in the extension.
                  Once approved the header shows your shortened address and you
                  can start reviewing and interacting with proposals.
                </p>
              </div>

              <div>
                <h3 className="text-lg font-semibold text-white">
                  Why does Accord ask for Freighter specifically?
                </h3>
                <p className="mt-2 text-sm leading-7 text-zinc-400 sm:text-base">
                  Accord relies on Freighter to sign Stellar transactions from
                  the browser. The app can read chain data without a wallet
                  connected, but it needs Freighter to sign any write operation
                  such as creating, approving, revoking, and executing proposals.
                </p>
              </div>

              <div>
                <h3 className="text-lg font-semibold text-white">
                  Why do I need testnet funds before I can use the app?
                </h3>
                <p className="mt-2 text-sm leading-7 text-zinc-400 sm:text-base">
                  Even on testnet, signed transactions still need an account that
                  exists on the network and can pay the small network fees
                  required to submit them. Use Friendbot, the Stellar testnet
                  faucet, to fund your account with free testnet XLM before
                  attempting any on-chain actions.
                </p>
              </div>

              <div>
                <h3 className="text-lg font-semibold text-white">
                  Can I approve my own proposal?
                </h3>
                <p className="mt-2 text-sm leading-7 text-zinc-400 sm:text-base">
                  Yes. If your address is one of the configured multisig owners
                  you can approve a proposal you created. Accord tracks
                  approvals by owner address rather than by proposal author, so
                  your own approval counts toward the threshold just like anyone
                  else's.
                </p>
              </div>

              <div>
                <h3 className="text-lg font-semibold text-white">
                  Can I change my mind after approving a proposal?
                </h3>
                <p className="mt-2 text-sm leading-7 text-zinc-400 sm:text-base">
                  Yes. An owner can revoke their own approval while the proposal
                  is still active. If the revocation brings the total approval
                  count back below the threshold the proposal drops from Ready
                  back to Pending. Once a proposal is Executed or Expired, revocation
                  is no longer possible.
                </p>
              </div>

              <div>
                <h3 className="text-lg font-semibold text-white">
                  Why can a proposal show Ready and still not move funds yet?
                </h3>
                <p className="mt-2 text-sm leading-7 text-zinc-400 sm:text-base">
                  Ready means the proposal has enough approvals to execute, but
                  an owner still has to submit the execute transaction before
                  funds actually move on chain. There may also be a time-lock
                  delay that blocks execution for a configurable period after the
                  proposal first becomes Ready, and the proposal can still expire
                  if the deadline passes before anyone executes it.
                </p>
              </div>

              <div>
                <h3 className="text-lg font-semibold text-white">
                  What should I do if my wallet is connected in read-only mode?
                </h3>
                <p className="mt-2 text-sm leading-7 text-zinc-400 sm:text-base">
                  Read-only mode means the connected address is not one of the
                  configured multisig owners, so you can inspect proposals and
                  dashboard data but cannot sign any owner-only actions. To
                  interact with proposals connect a wallet whose address is
                  listed as an owner in the contract.
                </p>
              </div>

              <div>
                <h3 className="text-lg font-semibold text-white">
                  What happens if a transaction fails or shows an error?
                </h3>
                <p className="mt-2 text-sm leading-7 text-zinc-400 sm:text-base">
                  Dismiss the error banner and check a few things: make sure
                  your Freighter wallet is set to the correct Stellar network,
                  confirm you have enough XLM to cover the transaction fee, and
                  verify the wallet is still connected. If the wallet disconnected
                  while a transaction was in flight reconnect and try again. The
                  dashboard will refresh with the latest on-chain state after a
                  successful action.
                </p>
              </div>

              <div>
                <h3 className="text-lg font-semibold text-white">
                  What is the read-only banner at the top of the dashboard?
                </h3>
                <p className="mt-2 text-sm leading-7 text-zinc-400 sm:text-base">
                  The read-only banner appears when your connected wallet address
                  is not part of the multisig owner set configured in the
                  contract. You can still view proposals, owners, and dashboard
                  stats, but you cannot approve, revoke, or execute any
                  proposal until you connect a wallet that is a registered owner.
                </p>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
