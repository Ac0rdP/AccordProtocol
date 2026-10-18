import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installPreviewSeed,
  isPreviewSeedEnabled,
  PREVIEW_SEED_FILE,
  previewSeedUrl,
} from "../previewSeed";

const SEED = {
  proposals: [
    {
      id: 1,
      kind: "transfer" as const,
      to: "GRECIPIENT",
      amount: "1000",
      token: "XLM",
      description: "Grant payout",
      approvals: 2,
      threshold: 2,
      status: "executed" as const,
      deadline: "2026-09-02",
      deadlineTs: 1756771200,
      createdAt: "2026-09-02T00:00:00Z",
      proposer: "GOWNER",
      userHasApproved: false,
      approverAddresses: [],
      category: "Grant" as const,
    },
  ],
  ownerCount: 1,
  owners: ["GOWNER"],
  deposits: [{ timestamp: 1756771200, token: "XLM", amount: "5000" }],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubSeedServer() {
  return vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith(PREVIEW_SEED_FILE)) {
      return new Response(JSON.stringify(SEED), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("passthrough", { status: 200 });
  });
}

describe("preview seed", () => {
  it("is disabled unless VITE_PREVIEW_SEED is 'true'", () => {
    expect(isPreviewSeedEnabled()).toBe(false);
    vi.stubEnv("VITE_PREVIEW_SEED", "true");
    expect(isPreviewSeedEnabled()).toBe(true);
  });

  it("builds the seed URL relative to the deploy base", () => {
    expect(previewSeedUrl()).toBe(`/${PREVIEW_SEED_FILE}`);
    vi.stubEnv("BASE_URL", "/pr-42/");
    expect(previewSeedUrl()).toBe(`/pr-42/${PREVIEW_SEED_FILE}`);
  });

  it("leaves fetch untouched when disabled", async () => {
    const fetchMock = stubSeedServer();
    vi.stubGlobal("fetch", fetchMock);
    await installPreviewSeed();
    expect(window.fetch).toBe(fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves analytics endpoints from the seed and passes unknown paths through", async () => {
    vi.stubEnv("VITE_PREVIEW_SEED", "true");
    const fetchMock = stubSeedServer();
    vi.stubGlobal("fetch", fetchMock);

    await installPreviewSeed();

    const summary = await (await window.fetch("/stats/summary")).json();
    expect(summary).toMatchObject({ ownerCount: 1, totalDisbursed: { XLM: "1000" } });

    const spend = await (await window.fetch("/spend/by-category")).json();
    expect(spend).toEqual([
      expect.objectContaining({ category: "Grant", token: "XLM", total: "1000" }),
    ]);

    const passthrough = await window.fetch("/assets/index.js");
    expect(await passthrough.text()).toBe("passthrough");
  });

  it("does not patch fetch when the seed cannot be loaded", async () => {
    vi.stubEnv("VITE_PREVIEW_SEED", "true");
    const fetchMock = vi.fn(async () => new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await installPreviewSeed();

    expect(window.fetch).toBe(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves fetch untouched when loading the seed rejects", async () => {
    vi.stubEnv("VITE_PREVIEW_SEED", "true");
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);

    await installPreviewSeed();

    expect(window.fetch).toBe(fetchMock);
  });

  it("routes Request objects and honours the request method", async () => {
    vi.stubEnv("VITE_PREVIEW_SEED", "true");
    const fetchMock = stubSeedServer();
    vi.stubGlobal("fetch", fetchMock);
    await installPreviewSeed();

    const balanceUrl = new URL("/treasury/balance", window.location.origin).href;
    const summary = await (await window.fetch(new Request(balanceUrl))).json();
    expect(summary).toHaveProperty("balances");

    const rejected = await window.fetch(new Request(balanceUrl, { method: "POST" }));
    expect(rejected.status).toBe(405);
  });

  it("accepts URL inputs and passes unparseable inputs through", async () => {
    vi.stubEnv("VITE_PREVIEW_SEED", "true");
    const fetchMock = stubSeedServer();
    vi.stubGlobal("fetch", fetchMock);
    await installPreviewSeed();

    const flow = await (await window.fetch(new URL("/treasury/flow", window.location.origin))).json();
    expect(Array.isArray(flow)).toBe(true);

    // An input that cannot be parsed as a URL falls through to the network.
    const passthrough = await window.fetch("http://[unterminated");
    expect(await passthrough.text()).toBe("passthrough");
  });
});
