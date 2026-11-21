# Proposal workflows

## Unified inbox

The proposal inbox is available at `/app/inbox`. It reads the contract configured by `VITE_CONTRACT_ADDRESS` by default, then any additional contract IDs saved by the user in the browser. Saved workspaces are local to that browser and use the same Soroban RPC endpoint and network as the app. A wallet can approve or execute only where its contract roles allow it.

The inbox scans proposal pages and includes pending approvals and ready executions for the connected wallet. It retains partial results and reports individual workspace read errors. Proposal comparison supports up to four selected proposals.

## IPFS attachments

Proposal attachment upload is optional and is available for transfer proposals. IPFS content is public and persistent; never upload sensitive files. Configure `VITE_IPFS_UPLOAD_ENDPOINT` with a trusted upload service. The endpoint accepts a multipart `file` field and must pin the file bytes as an IPFS CIDv1 raw block. It returns JSON with `cid` and, optionally, `sha256`:

```json
{
  "cid": "bafy...",
  "sha256": "64 lowercase hexadecimal characters"
}
```

The returned CID must be the canonical CIDv1 raw CID for the file's SHA-256 digest. The frontend verifies this before proposal submission. The contract stores only the 32-byte digest; the file itself and its name are not written on-chain. Do not place an upload-service secret in a `VITE_*` variable; enforce authentication and upload limits at the service.

For a cross-origin upload endpoint, allow its HTTPS origin through the frontend Content Security Policy with `VITE_CSP_EXTRA_CONNECT_SRC`.

The proposal form previews supported local images, PDFs, plain text, and CSV files before upload. The proposal detail view can derive the raw CID from the on-chain digest and link to an IPFS gateway.
