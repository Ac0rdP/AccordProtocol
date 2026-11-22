import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Account, Contract, Keypair, TransactionBuilder, nativeToScVal } from "@stellar/stellar-sdk";
import { TESTNET_PASSPHRASE } from "../config";
import {
  buildStellarTxUri,
  hashToHex,
  isValidContractId,
  isValidWalletAddress,
  parseWalletCallback,
  signedTransactionHash,
  verifySignedTransaction,
} from "./wallet";

const owner = Keypair.random();

function buildUnsignedTx(fee = "100") {
  const account = new Account(owner.publicKey(), "1");
  return new TransactionBuilder(account, { fee, networkPassphrase: TESTNET_PASSPHRASE })
    .addOperation(
      new Contract("CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS").call(
        "approve",
        nativeToScVal(owner.publicKey(), { type: "address" }),
        nativeToScVal(7n, { type: "u64" }),
      ),
    )
    .setTimeout(30)
    .build();
}

describe("wallet helpers", () => {
  it("validates Stellar addresses", () => {
    assert.equal(isValidWalletAddress(owner.publicKey()), true);
    assert.equal(isValidWalletAddress("not-an-address"), false);
    assert.equal(
      isValidContractId("CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS"),
      true,
    );
    assert.equal(isValidContractId(owner.publicKey()), false);
  });

  it("builds a SEP-0007 deep link preserving base64 XDR", () => {
    const xdr = buildUnsignedTx().toXDR();
    const uri = buildStellarTxUri({
      xdr,
      callback: "accord://wallet/callback",
      message: "Approve proposal #7",
    });
    assert.ok(uri.startsWith("web+stellar:tx?"));
    assert.ok(uri.includes("callback=accord%3A%2F%2Fwallet%2Fcallback"));
    assert.ok(uri.includes("msg=Approve%20proposal%20%237"));
    assert.equal(parseWalletCallback(uri).signedXdr, xdr);
  });

  it("rejects incomplete signing requests", () => {
    assert.throws(() => buildStellarTxUri({ xdr: "", callback: "accord://cb" }), /XDR/);
    assert.throws(() => buildStellarTxUri({ xdr: "x", callback: "" }), /callback/);
  });

  it("parses wallet callbacks from full URLs and raw query strings", () => {
    assert.deepEqual(parseWalletCallback("accord://wallet/callback?signed_xdr=abc%2Bdef%3D"), {
      signedXdr: "abc+def=",
    });
    assert.deepEqual(parseWalletCallback("signedTxXdr=xyz&foo=bar"), { signedXdr: "xyz" });
    assert.deepEqual(parseWalletCallback("accord://wallet/callback?error=user_rejected"), {
      error: "user_rejected",
    });
  });

  it("verifies the exact transaction was signed", () => {
    const unsignedXdr = buildUnsignedTx().toXDR();
    const signed = TransactionBuilder.fromXDR(unsignedXdr, TESTNET_PASSPHRASE);
    signed.sign(owner);
    const signedXdr = signed.toXDR();
    assert.equal(signedTransactionHash(signedXdr, TESTNET_PASSPHRASE), hashToHex(signed.hash()));
    assert.equal(verifySignedTransaction(unsignedXdr, signedXdr, TESTNET_PASSPHRASE), true);

    // A different transaction (changed fee) must never be accepted.
    const tampered = TransactionBuilder.fromXDR(buildUnsignedTx("200").toXDR(), TESTNET_PASSPHRASE);
    tampered.sign(owner);
    assert.equal(verifySignedTransaction(unsignedXdr, tampered.toXDR(), TESTNET_PASSPHRASE), false);
    assert.equal(verifySignedTransaction(unsignedXdr, "garbage", TESTNET_PASSPHRASE), false);
  });
});
