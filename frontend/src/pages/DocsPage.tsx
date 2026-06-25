import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

const SECTIONS = [
  { id: "what-is-accord", label: "What is Accord?" },
  { id: "getting-started", label: "Getting Started" },
  { id: "proposal-lifecycle", label: "Proposal Lifecycle" },
  { id: "faq", label: "FAQ" },
] as const;

export function DocsPage() {
  const [activeSection, setActiveSection] =
    useState<(typeof SECTIONS)[number]["id"]>("what-is-accord");
  const [searchQuery, setSearchQuery] = useState("");

  const filteredSections = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return normalizedQuery
      ? SECTIONS.filter((section) =>
          section.label.toLowerCase().includes(normalizedQuery),
        )
      : SECTIONS;
  }, [searchQuery]);

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

      <main className="mx-auto grid max-w-6xl gap-10 px-6 py-10 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <div className="rounded-2xl border border-zinc-900 bg-zinc-950/80 p-4">
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
              Accord is a Stellar Soroban multisig that lets a group manage one
              treasury without trusting one person to hold the funds. A proposal
              is created on-chain, other owners approve it until the threshold
              is met, and then any owner can execute it. That flow matters
              because the contract, not an individual wallet, becomes the
              custodian.
            </p>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-zinc-400 sm:text-base">
              The app is designed around a simple operating model: connect
              Freighter, verify you are on Stellar testnet, review proposals in
              the dashboard, and only sign actions your signer role is allowed
              to perform. The rest of this page focuses on getting a new user
              from zero setup to a successful wallet connection.
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
              Every proposal starts as Pending, moves to Ready when approvals
              reach the multisig threshold, and ends as Executed, Expired, or
              Revoked depending on what owners do next and whether the deadline
              passes first. Owners can also revoke an approval, which can drop a
              Ready proposal back to Pending until the threshold is restored.
            </p>
            <p className="mt-4 text-sm leading-7 text-zinc-400 sm:text-base">
              If you need the full state-by-state reference, including deadline
              behavior, active proposal limits, and the approval-revoke edge
              case, the repository now includes a dedicated tutorial in{" "}
              <span className="font-mono text-zinc-300">
                docs/tutorials/understanding-proposal-lifecycle.md
              </span>
              .
            </p>
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
              The quickest reference answers now live in{" "}
              <span className="font-mono text-zinc-300">docs/FAQ.md</span>. It
              groups common questions for users, developers, and general readers
              so someone can jump straight to wallet setup, proposal flow,
              testing, deployment, or Soroban background without reading every
              long-form document first.
            </p>
            <p className="mt-4 text-sm leading-7 text-zinc-400 sm:text-base">
              Use the FAQ when you need a direct answer, then move into the
              deeper setup, API, deployment, or security docs once you know
              which workflow you are trying to complete.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
