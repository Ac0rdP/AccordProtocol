#!/usr/bin/env node

/**
 * verify-signer-evidence.mjs — provider-neutral verification of Stellar Ed25519
 * detached signatures and HSM/MPC signing drill evidence without any private key.
 *
 * Usage:
 *   node scripts/verify-signer-evidence.mjs verify \
 *     --public-key=G... \
 *     --network=testnet \
 *     --payload-hex=<hex> \
 *     --signature=<base64-or-hex>
 *
 *   node scripts/verify-signer-evidence.mjs verify-evidence \
 *     --file=drill-evidence.json \
 *     [--expected-public-key=G...] \
 *     [--expected-network=testnet]
 *
 * Zero external dependencies: uses Node.js built-in `node:crypto` Ed25519 support.
 * Never accepts, stores, or prints private keys or Stellar secret seeds (S...).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NETWORK_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
};

// Stellar StrKey version bytes (SEP-0023)
const STRKEY_VERSION_ED25519_PUBLIC_KEY = 6 << 3; // 48 ('G')
const STRKEY_VERSION_ED25519_SECRET_SEED = 18 << 3; // 144 ('S')

// Stellar XDR EnvelopeType::ENVELOPE_TYPE_TX = 2 (4-byte big-endian)
const ENVELOPE_TYPE_TX_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x02]);

// ASN.1 SubjectPublicKeyInfo (SPKI) DER prefix for a 32-byte Ed25519 public key
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Computes CRC16-XModem checksum used by Stellar StrKey (little-endian in StrKey).
 */
export function crc16XModem(buffer) {
  let crc = 0x0000;
  for (const byte of buffer) {
    let code = (crc >>> 8) & 0xff;
    code ^= byte & 0xff;
    code ^= code >>> 4;
    crc = (crc << 8) & 0xffff;
    crc ^= code;
    code = (code << 5) & 0xffff;
    crc ^= code;
    code = (code << 7) & 0xffff;
    crc ^= code;
  }
  return crc;
}

/**
 * Encodes a Buffer to RFC 4648 Base32 (no padding).
 */
export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Decodes an RFC 4648 Base32 string (uppercase, no padding) into a Buffer.
 */
export function base32Decode(str) {
  if (typeof str !== "string" || str.length === 0) {
    throw new Error("Base32 input must be a non-empty string.");
  }
  if (!/^[A-Z2-7]+$/.test(str)) {
    throw new Error("Malformed Base32 string.");
  }
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of str) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Encodes a 32-byte raw Ed25519 public key into a Stellar StrKey `G...` address.
 */
export function encodeStellarPublicKey(rawPublicKey) {
  const buf = Buffer.from(rawPublicKey);
  if (buf.length !== 32) {
    throw new Error(`Ed25519 raw public key must be 32 bytes (got ${buf.length}).`);
  }
  const payload = Buffer.concat([Buffer.from([STRKEY_VERSION_ED25519_PUBLIC_KEY]), buf]);
  const checksum = Buffer.alloc(2);
  checksum.writeUInt16LE(crc16XModem(payload), 0);
  return base32Encode(Buffer.concat([payload, checksum]));
}

/**
 * Decodes and validates a Stellar StrKey `G...` Ed25519 public key into 32 raw bytes.
 * Explicitly rejects Stellar secret seeds (`S...`) without echoing the input.
 */
export function decodeStellarPublicKey(strKey) {
  if (typeof strKey !== "string" || strKey.trim().length === 0) {
    throw new Error("Expected a non-empty Stellar public key (G...).");
  }
  const trimmed = strKey.trim();

  // Never echo potential secret key material in error messages.
  if (trimmed.startsWith("S")) {
    throw new Error(
      "Secret seed rejected: pass only a public Stellar account key (G...), never a private seed.",
    );
  }
  if (trimmed.length !== 56 || !trimmed.startsWith("G")) {
    throw new Error("Invalid Stellar public key format: must be a 56-character G... StrKey.");
  }

  let decoded;
  try {
    decoded = base32Decode(trimmed);
  } catch {
    throw new Error("Invalid Stellar public key: malformed Base32 encoding.");
  }

  if (decoded.length !== 35) {
    throw new Error("Invalid Stellar public key: unexpected decoded length.");
  }

  const versionByte = decoded[0];
  if (versionByte === STRKEY_VERSION_ED25519_SECRET_SEED) {
    throw new Error("Secret seed rejected: pass only a public Stellar account key (G...).");
  }
  if (versionByte !== STRKEY_VERSION_ED25519_PUBLIC_KEY) {
    throw new Error("Invalid Stellar public key: unexpected StrKey version byte.");
  }

  const body = decoded.subarray(0, 33);
  const expectedChecksum = decoded.readUInt16LE(33);
  const actualChecksum = crc16XModem(body);
  if (expectedChecksum !== actualChecksum) {
    throw new Error("Invalid Stellar public key: CRC16 checksum mismatch.");
  }

  return decoded.subarray(1, 33);
}

/**
 * Resolves a network passphrase from either an explicit passphrase or a known network name.
 */
export function resolveNetworkPassphrase({ network, networkPassphrase } = {}) {
  if (networkPassphrase && typeof networkPassphrase === "string" && networkPassphrase.trim()) {
    return networkPassphrase.trim();
  }
  if (network && typeof network === "string") {
    const key = network.trim().toLowerCase();
    if (key in NETWORK_PASSPHRASES) {
      return NETWORK_PASSPHRASES[key];
    }
  }
  throw new Error(
    `Unknown or missing network: provide --network (${Object.keys(NETWORK_PASSPHRASES).join("|")}) or --network-passphrase.`,
  );
}

/**
 * Computes the Stellar network-domain-separated 32-byte signing digest:
 *   SHA-256( SHA-256(networkPassphrase) || ENVELOPE_TYPE_TX(0x00000002) || payloadBytes )
 *
 * Domain separation ensures a signature generated for Testnet cannot verify on Mainnet.
 */
export function buildStellarSigningDigest(payloadBytes, networkPassphrase) {
  if (!Buffer.isBuffer(payloadBytes) || payloadBytes.length === 0) {
    throw new Error("Signing payload must be a non-empty Buffer.");
  }
  if (!networkPassphrase || typeof networkPassphrase !== "string") {
    throw new Error("Network passphrase must be a non-empty string.");
  }
  const networkId = crypto.createHash("sha256").update(networkPassphrase, "utf8").digest();
  return crypto
    .createHash("sha256")
    .update(networkId)
    .update(ENVELOPE_TYPE_TX_BYTES)
    .update(payloadBytes)
    .digest();
}

/**
 * Decodes a 64-byte Ed25519 signature from hex (128 chars) or base64.
 */
export function decodeSignature(signatureStr) {
  if (typeof signatureStr !== "string" || signatureStr.trim().length === 0) {
    throw new Error("Signature must be a non-empty hex or base64 string.");
  }
  const trimmed = signatureStr.trim();
  let buf;
  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) {
    buf = Buffer.from(trimmed, "hex");
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    buf = Buffer.from(trimmed, "base64");
  } else {
    throw new Error("Malformed signature encoding: expected 128-char hex or base64.");
  }

  if (buf.length !== 64) {
    throw new Error(`Invalid Ed25519 signature length: expected 64 bytes (got ${buf.length}).`);
  }
  return buf;
}

/**
 * Decodes a non-empty hex string into a Buffer.
 */
export function decodePayloadHex(payloadHex) {
  if (typeof payloadHex !== "string" || payloadHex.trim().length === 0) {
    throw new Error("Payload hex must be a non-empty string.");
  }
  const trimmed = payloadHex.trim();
  if (trimmed.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(trimmed)) {
    throw new Error("Malformed payload hex: expected even-length hexadecimal string.");
  }
  return Buffer.from(trimmed, "hex");
}

/**
 * Verifies a detached Ed25519 signature over the Stellar network-scoped signing digest
 * using only the public key (G...), network passphrase, payload bytes, and signature.
 */
export function verifyDetachedSignature({
  publicKey,
  payloadHex,
  signature,
  network,
  networkPassphrase,
}) {
  const rawPubKey = decodeStellarPublicKey(publicKey);
  const passphrase = resolveNetworkPassphrase({ network, networkPassphrase });
  const payloadBytes = decodePayloadHex(payloadHex);
  const sigBytes = decodeSignature(signature);

  const signingDigest = buildStellarSigningDigest(payloadBytes, passphrase);
  const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, rawPubKey]);
  const keyObject = crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" });

  const valid = crypto.verify(null, signingDigest, keyObject, sigBytes);
  if (!valid) {
    return {
      valid: false,
      error:
        "Ed25519 signature verification failed (wrong public key, wrong network passphrase, or tampered payload).",
      publicKey: publicKey.trim(),
      networkPassphrase: passphrase,
      signingDigestHex: signingDigest.toString("hex"),
    };
  }

  return {
    valid: true,
    publicKey: publicKey.trim(),
    networkPassphrase: passphrase,
    signingDigestHex: signingDigest.toString("hex"),
    payloadSha256: crypto.createHash("sha256").update(payloadBytes).digest("hex"),
  };
}

/**
 * Verifies a structured HSM/MPC signing drill evidence JSON object.
 * Optional `expectedPublicKey` and `expectedNetwork` enforce policy bindings.
 */
export function verifySigningEvidence(
  evidence,
  { expectedPublicKey = null, expectedNetwork = null } = {},
) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("Evidence document must be a JSON object.");
  }

  const requiredFields = [
    "schemaVersion",
    "signerPublicKey",
    "network",
    "payloadHex",
    "signature",
  ];
  for (const field of requiredFields) {
    if (!evidence[field]) {
      throw new Error(`Evidence document is missing required field: ${field}`);
    }
  }

  if (evidence.schemaVersion !== 1) {
    throw new Error(`Unsupported evidence schemaVersion: ${evidence.schemaVersion}`);
  }

  // Reject any accidental private key fields in evidence artifacts
  for (const forbidden of ["secretKey", "privateKey", "seed", "mnemonic", "secretSeed"]) {
    if (forbidden in evidence) {
      throw new Error(
        `Evidence document contains forbidden sensitive field "${forbidden}"; never store private material in evidence.`,
      );
    }
  }

  if (expectedPublicKey && evidence.signerPublicKey.trim() !== expectedPublicKey.trim()) {
    throw new Error("Evidence signerPublicKey does not match the expected owner public key.");
  }

  if (expectedNetwork) {
    const expectedPassphrase = resolveNetworkPassphrase({ network: expectedNetwork });
    const actualPassphrase = resolveNetworkPassphrase({
      network: evidence.network,
      networkPassphrase: evidence.networkPassphrase,
    });
    if (actualPassphrase !== expectedPassphrase) {
      throw new Error(
        `Evidence network passphrase does not match expected network "${expectedNetwork}".`,
      );
    }
  }

  return verifyDetachedSignature({
    publicKey: evidence.signerPublicKey,
    payloadHex: evidence.payloadHex,
    signature: evidence.signature,
    network: evidence.network,
    networkPassphrase: evidence.networkPassphrase,
  });
}

function parseFlags(args) {
  const flags = {};
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) {
      flags[arg.slice(2)] = true;
    } else {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return flags;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (command === "verify") {
    const result = verifyDetachedSignature({
      publicKey: flags["public-key"],
      payloadHex: flags["payload-hex"],
      signature: flags.signature,
      network: flags.network,
      networkPassphrase: flags["network-passphrase"],
    });
    if (!result.valid) {
      console.error(`FAILED: ${result.error}`);
      process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "verify-evidence") {
    if (!flags.file) {
      console.error("Usage: verify-evidence --file=<path> [--expected-public-key=G...] [--expected-network=testnet]");
      process.exit(1);
    }
    const raw = fs.readFileSync(flags.file, "utf8");
    const evidence = JSON.parse(raw);
    const result = verifySigningEvidence(evidence, {
      expectedPublicKey: flags["expected-public-key"] || null,
      expectedNetwork: flags["expected-network"] || null,
    });
    if (!result.valid) {
      console.error(`FAILED: ${result.error}`);
      process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(
    "Usage:\n" +
      "  node scripts/verify-signer-evidence.mjs verify --public-key=G... --network=testnet --payload-hex=<hex> --signature=<base64|hex>\n" +
      "  node scripts/verify-signer-evidence.mjs verify-evidence --file=<path> [--expected-public-key=G...] [--expected-network=testnet]",
  );
  process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`Verification error: ${err.message}`);
    process.exit(1);
  }
}
