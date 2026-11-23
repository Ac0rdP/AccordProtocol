import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearSession,
  loadSession,
  saveSession,
  type SessionStorageLike,
} from "./session";

function memoryStorage(): SessionStorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
}

describe("wallet session storage", () => {
  it("round-trips a session and clears it", async () => {
    const storage = memoryStorage();
    await saveSession({ address: "GADDRESS", connectedAt: 123 }, storage);
    assert.deepEqual(await loadSession(storage), { address: "GADDRESS", connectedAt: 123 });
    await clearSession(storage);
    assert.equal(await loadSession(storage), null);
  });

  it("tolerates storage failures", async () => {
    const broken: SessionStorageLike = {
      getItem: async () => {
        throw new Error("locked");
      },
      setItem: async () => {
        throw new Error("locked");
      },
      removeItem: async () => {
        throw new Error("locked");
      },
    };
    assert.equal(await loadSession(broken), null);
  });
});
