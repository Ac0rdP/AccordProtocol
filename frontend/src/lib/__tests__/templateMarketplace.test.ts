import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUNDLED_MARKETPLACE_CATALOG,
  compareVersions,
  fetchMarketplaceTemplates,
  filterTemplates,
  getInstallState,
  getInstalledTemplates,
  installMarketplaceTemplate,
  parseCatalog,
  reconcileInstalls,
  uninstallMarketplaceTemplate,
  type MarketplaceTemplate,
} from "../templateMarketplace";
import { deleteProposalTemplate, getProposalTemplates } from "../proposalTemplates";

const template: MarketplaceTemplate = BUNDLED_MARKETPLACE_CATALOG[0];

beforeEach(() => {
  localStorage.clear();
});

describe("compareVersions", () => {
  it("compares numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("v2.0.0", "2.0")).toBe(0);
    expect(compareVersions("0.9.0", "1.0.0")).toBeLessThan(0);
  });
});

describe("parseCatalog", () => {
  it("accepts a bare list or a { templates } envelope and drops malformed entries", () => {
    expect(parseCatalog([template, { id: "bad" }])).toEqual([template]);
    expect(parseCatalog({ templates: [template] })).toEqual([template]);
  });

  it("rejects entries with an unknown category", () => {
    expect(parseCatalog([{ ...template, category: "Lottery" }])).toEqual([]);
  });

  it("throws when the payload is not a list", () => {
    expect(() => parseCatalog("nope")).toThrow("Template catalog is malformed");
  });
});

describe("fetchMarketplaceTemplates", () => {
  it("returns the bundled catalog when no URL is configured", async () => {
    await expect(fetchMarketplaceTemplates({ url: "" })).resolves.toBe(
      BUNDLED_MARKETPLACE_CATALOG,
    );
  });

  it("fetches and validates a remote catalog", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ templates: [template, { id: 1 }] }),
    });
    const result = await fetchMarketplaceTemplates({
      url: "https://example.test/catalog.json",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual([template]);
  });

  it("surfaces HTTP failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(
      fetchMarketplaceTemplates({
        url: "https://example.test/catalog.json",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow("responded with 503");
  });
});

describe("install lifecycle", () => {
  it("installs into the saved-template list used by the proposal picker", () => {
    installMarketplaceTemplate(template);
    const saved = getProposalTemplates();
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe(template.name);
    expect(saved[0].fields.amount).toBe(template.fields.amount);
    expect(getInstallState(template, getInstalledTemplates())).toBe("installed");
  });

  it("reports an available update and replaces the old copy instead of duplicating it", () => {
    installMarketplaceTemplate({ ...template, version: "1.0.0", fields: { amount: "1" } });
    expect(getInstallState(template, getInstalledTemplates())).toBe("update_available");

    installMarketplaceTemplate(template);
    const saved = getProposalTemplates();
    expect(saved).toHaveLength(1);
    expect(saved[0].fields.amount).toBe(template.fields.amount);
    expect(getInstalledTemplates()[template.id].version).toBe(template.version);
  });

  it("uninstalls both the record and the saved copy", () => {
    installMarketplaceTemplate(template);
    uninstallMarketplaceTemplate(template.id);
    expect(getProposalTemplates()).toEqual([]);
    expect(getInstalledTemplates()).toEqual({});
  });

  it("forgets installs whose saved copy was deleted from the picker", () => {
    const record = installMarketplaceTemplate(template);
    deleteProposalTemplate(record.localTemplateId);
    expect(reconcileInstalls()).toEqual({});
    expect(getInstallState(template, getInstalledTemplates())).toBe("not_installed");
  });

  it("throws a readable error when storage is unavailable", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    expect(() => installMarketplaceTemplate(template)).toThrow("Browser storage is unavailable");
    spy.mockRestore();
  });
});

describe("filterTemplates", () => {
  it("filters by category and free-text over name, summary, author, and tags", () => {
    const all = BUNDLED_MARKETPLACE_CATALOG;
    expect(filterTemplates(all, { query: "", category: "Grant" }).every((t) => t.category === "Grant")).toBe(true);
    expect(filterTemplates(all, { query: "SECURITY", category: "all" }).map((t) => t.id)).toEqual([
      "bug-bounty-payout",
    ]);
    expect(filterTemplates(all, { query: "zzz", category: "all" })).toEqual([]);
  });
});
