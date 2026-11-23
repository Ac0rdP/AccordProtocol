import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectLedgerWallet,
  connectPasskeyWallet,
  connectWalletConnect,
  createWalletConnectPairingUri,
  isValidLedgerPath,
  loadActiveSessionId,
  loadStoredSessions,
  makeSessionId,
  saveActiveSessionId,
  saveStoredSessions,
  signWithActiveSession,
  upsertSession,
  type WalletSession,
} from "../walletProviders";

describe("walletProviders", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete window.__ACCORD_LEDGER__;
    delete window.__ACCORD_WALLETCONNECT__;
    delete window.__ACCORD_PASSKEY__;
  });

  afterEach(() => {
    delete window.__ACCORD_LEDGER__;
    delete window.__ACCORD_WALLETCONNECT__;
    delete window.__ACCORD_PASSKEY__;
  });

  it("persists and upserts multiple wallet sessions", () => {
    const s1: WalletSession = {
      id: makeSessionId("freighter", "GAAA1111"),
      provider: "freighter",
      address: "GAAA1111",
      label: "Freighter",
      connectedAt: 1,
    };
    const s2: WalletSession = {
      id: makeSessionId("ledger", "GBBB2222"),
      provider: "ledger",
      address: "GBBB2222",
      label: "Ledger (44'/148'/0')",
      derivationPath: "44'/148'/0'",
      connectedAt: 2,
    };

    const list = upsertSession(upsertSession([], s1), s2);
    saveStoredSessions(list);
    saveActiveSessionId(s2.id);

    expect(loadStoredSessions()).toHaveLength(2);
    expect(loadActiveSessionId()).toBe(s2.id);

    const updated = upsertSession(list, { ...s1, label: "Primary Freighter" });
    expect(updated).toHaveLength(2);
    expect(updated[0].label).toBe("Primary Freighter");
  });

  it("validates Ledger derivation paths and signs via hardware bridge without storing secrets", async () => {
    expect(isValidLedgerPath("44'/148'/0'")).toBe(true);
    expect(isValidLedgerPath("invalid-path")).toBe(false);

    const invalid = await connectLedgerWallet({ derivationPath: "bad" });
    expect(invalid.ok).toBe(false);

    const signTransaction = vi.fn().mockResolvedValue("SIGNED_LEDGER_XDR");
    window.__ACCORD_LEDGER__ = {
      getPublicKey: vi.fn().mockResolvedValue("GLEDGERADDRESS123456"),
      signTransaction,
    };

    const connected = await connectLedgerWallet({ derivationPath: "44'/148'/1'" });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;

    expect(connected.value.provider).toBe("ledger");
    expect(connected.value.derivationPath).toBe("44'/148'/1'");
    expect("secretKey" in connected.value).toBe(false);

    const signed = await signWithActiveSession(connected.value, "RAW_XDR", "TESTNET");
    expect(signed).toEqual({ ok: true, value: "SIGNED_LEDGER_XDR" });
    expect(signTransaction).toHaveBeenCalledWith(
      "RAW_XDR",
      "44'/148'/1'",
      "Test SDF Network ; September 2015"
    );
  });

  it("creates WalletConnect pairing URIs and signs through the same flow", async () => {
    const uri = createWalletConnectPairingUri();
    expect(uri.startsWith("wc:")).toBe(true);
    expect(uri).toContain("@2?relay-protocol=irn&symKey=");

    const signTransaction = vi.fn().mockResolvedValue("SIGNED_WC_XDR");
    window.__ACCORD_WALLETCONNECT__ = {
      connect: vi.fn().mockResolvedValue({ address: "GWCADDRESS123456", topic: "topic-1" }),
      signTransaction,
    };

    const connected = await connectWalletConnect({ pairingUri: uri });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;

    expect(connected.value.provider).toBe("walletconnect");
    expect(connected.value.topic).toBe("topic-1");

    const signed = await signWithActiveSession(connected.value, "RAW_XDR", "PUBLIC");
    expect(signed).toEqual({ ok: true, value: "SIGNED_WC_XDR" });
    expect(signTransaction).toHaveBeenCalledWith(
      "RAW_XDR",
      "topic-1",
      "Public Global Stellar Network ; September 2015"
    );
  });

  it("supports passkey smart-wallet registration, login, and signing", async () => {
    const register = vi.fn().mockResolvedValue({
      address: "CPASSKEYSMARTWALLET1",
      credentialId: "cred-1",
    });
    const authenticate = vi.fn().mockResolvedValue({
      address: "CPASSKEYSMARTWALLET1",
      credentialId: "cred-1",
    });
    const signTransaction = vi.fn().mockResolvedValue("SIGNED_PASSKEY_XDR");
    window.__ACCORD_PASSKEY__ = { register, authenticate, signTransaction };

    const reg = await connectPasskeyWallet({ passkeyMode: "register", label: "Treasury Key" });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    expect(reg.value.label).toBe("Treasury Key");
    expect(reg.value.credentialId).toBe("cred-1");

    const login = await connectPasskeyWallet({ passkeyMode: "login" });
    expect(login.ok).toBe(true);

    const signed = await signWithActiveSession(reg.value, "RAW_XDR", "TESTNET");
    expect(signed).toEqual({ ok: true, value: "SIGNED_PASSKEY_XDR" });
  });
});
