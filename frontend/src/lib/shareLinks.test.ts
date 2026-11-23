import { describe, expect, it } from "vitest";
import {
  buildProposalEmbedUrl,
  buildProposalShareUrl,
  buildTreasuryEmbedUrl,
  isPublicShareRoute,
  parseEmbedParams,
  parseProposalId,
  redactShareError,
  resolvePublicDeepLink,
} from "./shareLinks";

describe("shareLinks utilities", () => {
  describe("parseProposalId", () => {
    it("accepts positive safe integers as strings or numbers", () => {
      expect(parseProposalId("1")).toBe(1);
      expect(parseProposalId("42")).toBe(42);
      expect(parseProposalId(" 99 ")).toBe(99);
      expect(parseProposalId(7)).toBe(7);
      expect(parseProposalId(String(Number.MAX_SAFE_INTEGER))).toBe(
        Number.MAX_SAFE_INTEGER,
      );
    });

    it("rejects zero, negative, leading-zero, non-numeric, and unsafe integer values", () => {
      expect(parseProposalId("0")).toBeNull();
      expect(parseProposalId(0)).toBeNull();
      expect(parseProposalId("-1")).toBeNull();
      expect(parseProposalId(-5)).toBeNull();
      expect(parseProposalId("01")).toBeNull();
      expect(parseProposalId("1.5")).toBeNull();
      expect(parseProposalId("1e5")).toBeNull();
      expect(parseProposalId("abc")).toBeNull();
      expect(parseProposalId("../settings")).toBeNull();
      expect(parseProposalId("9007199254740992")).toBeNull();
      expect(parseProposalId(null)).toBeNull();
      expect(parseProposalId(undefined)).toBeNull();
      expect(parseProposalId("")).toBeNull();
    });
  });

  describe("parseEmbedParams", () => {
    it("parses valid theme and compact parameters", () => {
      expect(parseEmbedParams("?theme=light&compact=true")).toEqual({
        theme: "light",
        compact: true,
      });
      expect(parseEmbedParams("?theme=dark&compact=1")).toEqual({
        theme: "dark",
        compact: true,
      });
    });

    it("falls back to dark and non-compact on missing or invalid query values", () => {
      expect(parseEmbedParams("")).toEqual({
        theme: "dark",
        compact: false,
      });
      expect(parseEmbedParams("?theme=neon&compact=maybe")).toEqual({
        theme: "dark",
        compact: false,
      });
    });
  });

  describe("URL builders", () => {
    it("builds canonical proposal share and embed URLs", () => {
      expect(buildProposalShareUrl("https://accord.example", 12)).toBe(
        "https://accord.example/proposals/12",
      );
      expect(
        buildProposalEmbedUrl("https://accord.example", 12, {
          theme: "light",
          compact: true,
        }),
      ).toBe(
        "https://accord.example/embed/proposals/12?theme=light&compact=true",
      );
      expect(
        buildProposalEmbedUrl("https://accord.example", 5),
      ).toBe("https://accord.example/embed/proposals/5");
      expect(
        buildTreasuryEmbedUrl("https://accord.example", { theme: "dark" }),
      ).toBe("https://accord.example/embed/treasury?theme=dark");
      expect(buildTreasuryEmbedUrl("https://accord.example")).toBe(
        "https://accord.example/embed/treasury",
      );
    });

    it("throws on invalid proposal IDs when building URLs", () => {
      expect(() => buildProposalShareUrl("https://accord.example", 0)).toThrow(
        /positive safe integer/i,
      );
      expect(() => buildProposalEmbedUrl("https://accord.example", -3)).toThrow(
        /positive safe integer/i,
      );
    });
  });

  describe("isPublicShareRoute and resolvePublicDeepLink", () => {
    it("recognizes public share links and query deep links", () => {
      expect(isPublicShareRoute("/proposals/1", "")).toBe(true);
      expect(isPublicShareRoute("/app/proposals/42", "")).toBe(true);
      expect(isPublicShareRoute("/app", "?proposal=3")).toBe(true);
      expect(isPublicShareRoute("/app", "")).toBe(false);
      expect(isPublicShareRoute("/app/settings", "")).toBe(false);
    });

    it("resolves valid share and deep links to /app/proposals/:id", () => {
      expect(resolvePublicDeepLink("/proposals/1", "")).toBe(
        "/app/proposals/1",
      );
      expect(resolvePublicDeepLink("/app", "?proposal=2")).toBe(
        "/app/proposals/2",
      );
      expect(resolvePublicDeepLink("/app/owners", "")).toBeNull();
    });

    it("neutralizes path-traversal and malformed deep links to /app/proposals/invalid", () => {
      expect(resolvePublicDeepLink("/proposals/not-a-number", "")).toBe(
        "/app/proposals/invalid",
      );
      expect(resolvePublicDeepLink("/proposals/0", "")).toBe(
        "/app/proposals/invalid",
      );
      expect(resolvePublicDeepLink("/app", "?proposal=../settings")).toBe(
        "/app/proposals/invalid",
      );
      expect(resolvePublicDeepLink("/app", "?proposal=")).toBe(
        "/app/proposals/invalid",
      );
    });
  });

  describe("redactShareError", () => {
    it("redacts bearer tokens, URL credentials, and API keys from error messages", () => {
      const token = ["tok", "0123456789abcdefghij"].join("_");
      const raw = new Error(
        `RPC failed at https://user:my_secret_pw@rpc.example?api_key=${token} with Bearer ${token}`,
      );
      const safe = redactShareError(raw);
      expect(safe).not.toContain(token);
      expect(safe).not.toContain("my_secret_pw");
      expect(safe).toContain("[REDACTED]");
      expect(redactShareError("plain failure")).toBe("plain failure");
      expect(redactShareError(null)).toBe("Unexpected error");
    });
  });
});
