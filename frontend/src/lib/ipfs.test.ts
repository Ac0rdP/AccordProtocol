import { describe, expect, test } from "vitest";
import { rawCidForDigest, rawCidFromDigestHex, uploadIpfsAttachment } from "./ipfs";

describe("IPFS attachment helpers", () => {
  test("derives a canonical CIDv1 raw identifier from a 32-byte digest", () => {
    const digest = new Uint8Array(32);
    const cid = rawCidForDigest(digest);
    expect(cid).toMatch(/^b[a-z2-7]{58}$/);
    expect(rawCidFromDigestHex("00".repeat(32))).toBe(cid);
  });

  test("rejects malformed on-chain digests", () => {
    expect(rawCidFromDigestHex("not-a-digest")).toBeNull();
  });

  test("rejects empty documents before contacting the upload service", async () => {
    await expect(uploadIpfsAttachment(new File([], "empty.txt"))).rejects.toThrow(
      "non-empty attachment",
    );
  });
});
