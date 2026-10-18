# Changelog

All notable changes to `@accord-protocol/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-18

### Added
- Initial release of `@accord-protocol/sdk`.
- Complete wrapper for Accord Protocol multisig smart contract entrypoints and view functions.
- Dual ESM and CommonJS bundle distributions with full TypeScript declaration maps.
- Simulation-based reads and caller-supplied signing callback model for zero-secret handling.
- Complete 64-bit and 128-bit integer precision representation as JavaScript `bigint`.
- Address validation before executing any network calls.
- Typed SDK errors mapping all 57 on-chain `ContractError` codes.
- Comprehensive unit test suite with mock RPC server.
