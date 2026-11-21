import { describe, expect, it } from "vitest";
import {
  applyWorkspaceBranding,
  buildDnsVerificationRecord,
  isValidCustomDomain,
  isValidHexColor,
  isValidLogoUrl,
  validateBrandingDraft,
} from "./branding";

describe("branding helpers", () => {
  it("validates hex colors, https logo URLs, and hostnames", () => {
    expect(isValidHexColor("#2563EB")).toBe(true);
    expect(isValidHexColor("blue")).toBe(false);

    expect(isValidLogoUrl("https://cdn.example.org/logo.svg")).toBe(true);
    expect(isValidLogoUrl("http://cdn.example.org/logo.svg")).toBe(false);

    expect(isValidCustomDomain("treasury.acme.org")).toBe(true);
    expect(isValidCustomDomain("invalid domain")).toBe(false);
  });

  it("collects field errors for invalid branding drafts", () => {
    const errors = validateBrandingDraft({
      brandName: "x".repeat(81),
      logoUrl: "http://example.com/a.png",
      primaryColor: "#123",
      accentColor: "green",
      customDomain: "-bad.example.com",
    });

    expect(Object.keys(errors)).toEqual([
      "brandName",
      "logoUrl",
      "primaryColor",
      "accentColor",
      "customDomain",
    ]);
  });

  it("builds DNS TXT verification records and applies CSS custom properties", () => {
    expect(buildDnsVerificationRecord("Treasury.Acme.org", "accord-verify=abc123")).toEqual({
      recordType: "TXT",
      host: "_accord-verification.treasury.acme.org",
      value: "accord-verify=abc123",
    });

    const el = document.createElement("div");
    applyWorkspaceBranding({ primaryColor: "#1D4ED8", accentColor: "#0EA5E9" }, el);
    expect(el.style.getPropertyValue("--accord-brand-primary")).toBe("#1d4ed8");
    expect(el.style.getPropertyValue("--accord-brand-accent")).toBe("#0ea5e9");

    applyWorkspaceBranding({ primaryColor: null, accentColor: null }, el);
    expect(el.style.getPropertyValue("--accord-brand-primary")).toBe("");
  });
});
