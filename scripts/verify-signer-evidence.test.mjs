import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  buildStellarSigningDigest,
  decodeStellarPublicKey,
  encodeStellarPublicKey,
  NETWORK_PASSPHRASES,
  verifyDetachedSignature,
  verifySigningEvidence,
} from "./verify-signer-evidence.mjs";

/**
 * Generates an ephemeral, throwaway Ed25519 keypair in memory for unit tests ONLY.
 * Never persisted, never used on any real Stellar network.
 */
function generateThrowawayTestSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const rawPublicKey = spki.subarray(spki.length - 32);
  const stellarPublicKey = encodeStellarPublicKey(rawPublicKey);
  return { stellarPublicKey, privateKey, rawPublicKey };
}

function signThrowawayPayload(privateKey, payloadHex, networkPassphrase) {
  const digest = buildStellarSigningDigest(Buffer.from(payloadHex, "hex"), networkPassphrase);
  return crypto.sign(null, digest, privateKey).toString("base64");
}

const SAMPLE_PAYLOAD_HEX = Buffer.from("accord:tx-envelope:upgrade-rehearsal:v1", "utf8").toString(
  "hex",
);

test("success: detached Ed25519 signature from throwaway test key verifies on testnet and mainnet", () => {
  const signer = generateThrowawayTestSigner();

  const testnetSig = signThrowawayPayload(
    signer.privateKey,
    SAMPLE_PAYLOAD_HEX,
    NETWORK_PASSPHRASES.testnet,
  );
  const testnetRes = verifyDetachedSignature({
    publicKey: signer.stellarPublicKey,
    payloadHex: SAMPLE_PAYLOAD_HEX,
    signature: testnetSig,
    network: "testnet",
  });
  assert.equal(testnetRes.valid, true);
  assert.equal(testnetRes.publicKey, signer.stellarPublicKey);
  assert.equal(testnetRes.networkPassphrase, NETWORK_PASSPHRASES.testnet);

  const mainnetSig = signThrowawayPayload(
    signer.privateKey,
    SAMPLE_PAYLOAD_HEX,
    NETWORK_PASSPHRASES.mainnet,
  );
  const mainnetRes = verifyDetachedSignature({
    publicKey: signer.stellarPublicKey,
    payloadHex: SAMPLE_PAYLOAD_HEX,
    signature: mainnetSig,
    network: "mainnet",
  });
  assert.equal(mainnetRes.valid, true);
  assert.equal(mainnetRes.networkPassphrase, NETWORK_PASSPHRASES.mainnet);
});

test("boundary: signature signed for testnet fails verification on mainnet passphrase", () => {
  const signer = generateThrowawayTestSigner();
  const testnetSig = signThrowawayPayload(
    signer.privateKey,
    SAMPLE_PAYLOAD_HEX,
    NETWORK_PASSPHRASES.testnet,
  );

  const crossNetwork = verifyDetachedSignature({
    publicKey: signer.stellarPublicKey,
    payloadHex: SAMPLE_PAYLOAD_HEX,
    signature: testnetSig,
    network: "mainnet",
  });

  assert.equal(crossNetwork.valid, false);
  assert.match(crossNetwork.error, /network passphrase|verification failed/i);
});

test("failure: wrong public key and tampered payload fail cleanly", () => {
  const signerA = generateThrowawayTestSigner();
  const signerB = generateThrowawayTestSigner();
  const sigA = signThrowawayPayload(
    signerA.privateKey,
    SAMPLE_PAYLOAD_HEX,
    NETWORK_PASSPHRASES.testnet,
  );

  const wrongKey = verifyDetachedSignature({
    publicKey: signerB.stellarPublicKey,
    payloadHex: SAMPLE_PAYLOAD_HEX,
    signature: sigA,
    network: "testnet",
  });
  assert.equal(wrongKey.valid, false);

  // Flip the last hex byte of the payload
  const tamperedHex =
    SAMPLE_PAYLOAD_HEX.slice(0, -2) +
    (SAMPLE_PAYLOAD_HEX.slice(-2) === "00" ? "01" : "00");
  const tampered = verifyDetachedSignature({
    publicKey: signerA.stellarPublicKey,
    payloadHex: tamperedHex,
    signature: sigA,
    network: "testnet",
  });
  assert.equal(tampered.valid, false);
});

test("failure: secret seed, corrupted StrKey checksum, and malformed inputs fail without printing key material", () => {
  const fakeSecretSeed = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  try {
    decodeStellarPublicKey(fakeSecretSeed);
    assert.fail("Expected secret seed to be rejected");
  } catch (err) {
    assert.match(err.message, /Secret seed rejected/i);
    assert.ok(!err.message.includes(fakeSecretSeed), "Error message must never echo secret material");
  }

  const signer = generateThrowawayTestSigner();
  const lastChar = signer.stellarPublicKey.at(-1);
  const badChecksumKey =
    signer.stellarPublicKey.slice(0, -1) + (lastChar === "A" ? "B" : "A");

  assert.throws(() => decodeStellarPublicKey(badChecksumKey), /checksum mismatch/i);

  assert.throws(
    () =>
      verifyDetachedSignature({
        publicKey: signer.stellarPublicKey,
        payloadHex: "not-hex!!",
        signature: Buffer.alloc(64).toString("base64"),
        network: "testnet",
      }),
    /Malformed payload hex/i,
  );

  assert.throws(
    () =>
      verifyDetachedSignature({
        publicKey: signer.stellarPublicKey,
        payloadHex: SAMPLE_PAYLOAD_HEX,
        signature: Buffer.alloc(32).toString("base64"),
        network: "testnet",
      }),
    /expected 64 bytes/i,
  );
});

test("signing drill evidence JSON verifies and rejects forbidden private key fields", () => {
  const signer = generateThrowawayTestSigner();
  const signature = signThrowawayPayload(
    signer.privateKey,
    SAMPLE_PAYLOAD_HEX,
    NETWORK_PASSPHRASES.testnet,
  );

  const evidence = {
    schemaVersion: 1,
    drillId: "drill-2026-11-20-testnet",
    providerType: "provider-neutral-test-fixture",
    signerPublicKey: signer.stellarPublicKey,
    network: "testnet",
    payloadHex: SAMPLE_PAYLOAD_HEX,
    signature,
    approvedBy: ["operator-a", "operator-b"],
    recordedAt: "2026-11-20T00:00:00Z",
  };

  const ok = verifySigningEvidence(evidence, {
    expectedPublicKey: signer.stellarPublicKey,
    expectedNetwork: "testnet",
  });
  assert.equal(ok.valid, true);

  assert.throws(
    () => verifySigningEvidence({ ...evidence, secretSeed: "SFAKE..." }),
    /forbidden sensitive field/i,
  );
});

test("regression fixture: Stellar StrKey round-trip and deterministic network signing digest", () => {
  // Deterministic 32-byte all-zero public key test vector -> GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF
  const zeroKey = Buffer.alloc(32, 0);
  const encoded = encodeStellarPublicKey(zeroKey);
  assert.equal(encoded, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
  assert.deepEqual(decodeStellarPublicKey(encoded), zeroKey);

  const digestTestnet = buildStellarSigningDigest(
    Buffer.from("deadbeef", "hex"),
    NETWORK_PASSPHRASES.testnet,
  );
  const digestMainnet = buildStellarSigningDigest(
    Buffer.from("deadbeef", "hex"),
    NETWORK_PASSPHRASES.mainnet,
  );
  assert.equal(digestTestnet.length, 32);
  assert.equal(digestMainnet.length, 32);
  assert.notDeepEqual(digestTestnet, digestMainnet);
});
