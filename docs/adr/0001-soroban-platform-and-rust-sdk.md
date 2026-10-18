# ADR-0001: Soroban Smart Contract Platform and Rust SDK

- **Status**: accepted (backfilled and reconstructed record)
- **Date**: 2026-05-04 (commit `94adbe3`)
- **Type**: Architectural Foundation

## Context

Accord Protocol requires a decentralized smart contract runtime on the Stellar network capable of handling multi-signature treasury operations, arbitrary token disbursements, time-locks, and complex governance logic.

## Decision

The protocol smart contracts are implemented in Rust using the Soroban SDK (`soroban-sdk = "=25.3.1"`), compiled targeting `wasm32v1-none`. The contract runs directly on the Soroban WebAssembly host environment on Stellar.

## Consequences

### Positive
- Native execution and transaction simulation through Stellar's Soroban RPC.
- Type-safe contract types (`#[contracttype]`) and host functions with zero-cost abstractions in `#![no_std]` Rust.
- Interoperability with standard Stellar tokens and SEP-41 token interfaces via `soroban_sdk::token::Client`.

### Negative / Trade-offs
- Strict WASM binary size and CPU instruction limits enforced by the Soroban host environment.
- Lack of standard library (`#![no_std]`), requiring specialized SDK collections (`Vec`, `Map`, `String`).

### Neutral
- Deployed contracts must be built with compatible Stellar CLI / Rust toolchain configurations.

## Alternatives Considered

- *Rationale not recorded; reconstructed from code and documentation.*

## Links & Evidence

- Manifest: `Cargo.toml`, `contracts/accord/Cargo.toml`
- Source: `contracts/accord/src/lib.rs`
- Commit: `94adbe3` ("quorom", 2026-05-04)
- Documentation: `docs/ARCHITECTURE.md` §1 (System Overview)
