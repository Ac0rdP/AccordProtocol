import { test as base } from "@playwright/test";

const TEST_WALLET = "GDJSB22NWBU7IV44SHHG6WO6AJTUED2KNKWL2DYNJJ5X7M5SG7UVC7JD";

// Injected into the browser page before any app script runs.
// Stubs the Freighter wallet extension API (v6) which uses window.postMessage.
//
// isConnected() checks window.freighter first — if truthy it short-circuits and
// returns { isConnected: true } without touching postMessage.
//
// Every other API call (getAddress, signTransaction, getNetworkDetails, …) goes
// through freighter-api's internal n() helper which posts a
// FREIGHTER_EXTERNAL_MSG_REQUEST and waits for FREIGHTER_EXTERNAL_MSG_RESPONSE
// with a matching messagedId (note the typo — that is the real field name).
//
// We override window.postMessage so outbound FREIGHTER requests never reach the
// extension channel; instead we respond immediately via the *original*
// window.postMessage so the event.source === window check inside n() passes.
const FREIGHTER_STUB = `
(function () {
  var DEFAULT_WALLET = "${TEST_WALLET}";

  function currentWallet() {
    return window.__TEST_WALLET__ || DEFAULT_WALLET;
  }

  window.freighter = true;

  var _orig = window.postMessage.bind(window);

  window.postMessage = function (msg, targetOrigin, transfer) {
    if (!msg || msg.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") {
      return _orig(msg, targetOrigin, transfer);
    }

    console.log("[STUB] type:", msg.type, "id:", msg.messageId);

    var resp = { source: "FREIGHTER_EXTERNAL_MSG_RESPONSE", messagedId: msg.messageId };

    switch (msg.type) {
      case "REQUEST_PUBLIC_KEY":
      case "REQUEST_ACCESS":
        resp.publicKey = currentWallet();
        break;
      case "SUBMIT_TRANSACTION":
        resp.signedTransaction = msg.transactionXdr;
        resp.signerAddress = currentWallet();
        break;
      case "REQUEST_NETWORK_DETAILS":
        resp.networkDetails = {
          network: "TESTNET",
          networkPassphrase: "Test SDF Network ; September 2015",
          networkUrl: "https://soroban-testnet.stellar.org",
          sorobanRpcUrl: "",
        };
        break;
      case "REQUEST_CONNECTION_STATUS":
        resp.isConnected = true;
        break;
      case "REQUEST_ALLOWED_STATUS":
        resp.isAllowed = true;
        break;
    }

    setTimeout(function () {
      console.log("[STUB] responding id:", resp.messagedId, "type:", msg.type);
      _orig(resp, "*");
    }, 0);
  };
})();
`;

export const test = base.extend<Record<string, never>>({
  page: async ({ page }, use) => {
    await page.addInitScript({ content: FREIGHTER_STUB });
    await use(page);
  },
});

export { expect } from "@playwright/test";
export { TEST_WALLET };
