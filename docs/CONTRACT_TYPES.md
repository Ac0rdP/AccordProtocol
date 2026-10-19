# Generated contract types

The frontend must never disagree with the on-chain data model. To guarantee
that, the contract-derived TypeScript types are **generated** from the Soroban
interface in [`contracts/accord/src/lib.rs`](../contracts/accord/src/lib.rs)
instead of being maintained by hand.

## Source of truth

`contracts/accord/src/lib.rs` is the single source of truth. Every
`#[contracttype]` struct/enum and the `#[contracterror]` enum are extracted and
emitted to:

```
frontend/src/types/contract.generated.ts
```

That file is **checked in** so the frontend can import the contract types
without a Rust toolchain, but it is generated — treat it as read-only.

## Regenerating

Run the generator after changing any `#[contracttype]` or `#[contracterror]`
definition:

```bash
python3 scripts/generate-contract-types.py
```

This writes `frontend/src/types/contract.generated.ts`. Commit the regenerated
file together with the contract change. From the frontend directory you can use
the package script instead:

```bash
npm run types:generate
```

## CI staleness check

CI re-runs the generator and fails when the checked-in file is out of date:

```bash
python3 scripts/generate-contract-types.py
git diff --exit-code -- frontend/src/types/contract.generated.ts
```

The `contract-types` job in
[`.github/workflows/frontend-ci.yml`](../.github/workflows/frontend-ci.yml)
enforces this. If the job fails, regenerate locally and commit the result.

## How the frontend consumes them

Generated names are prefixed with `Contract` (for example
`ContractProposalStatus`, `ContractRole`) to avoid clashing with the
view-model types the UI already exposes. `ContractError` keeps its name
because it is emitted as a runtime `enum`.

`frontend/src/types/accord.ts` derives the app-facing types from the generated
ones — for example:

```ts
import type {
  ContractProposalStatus,
  ContractRole,
} from "./contract.generated";

export type ProposalStatus = Lowercase<ContractProposalStatus>;
export type Role = "Owner" | "Guardian" | "SpendingLimit" | ContractRole;
```

`frontend/src/types/contract.generated.test.ts` asserts these relationships at
the type level, so a hand-written duplicate that drifts from the contract will
fail the unit test suite as well as the staleness check.

## Known limitations

- The generator understands the shapes used by this contract today
  (`Option`, `Vec`, `Map`, tuples, `BytesN`, and the primitive aliases listed in
  `scripts/generate-contract-types.py`). Unrecognised Rust types map to
  `unknown`, which keeps the output valid TypeScript but should be extended in
  the generator rather than patched by hand.
- Struct fields keep their Rust `snake_case` names so the generated types map
  directly onto `scValToNative` output; conversion to the UI's view models still
  happens in `frontend/src/lib/`.
