import { describe, expect, it } from "vitest";
import { isValidWebhookUrl, validateWebhookDraft } from "./workflows";

describe("workflow webhook helpers", () => {
  it("accepts public HTTPS Zapier and generic webhook URLs and rejects private/HTTP URLs", () => {
    expect(isValidWebhookUrl("https://hooks.zapier.com/hooks/catch/1234/abcd/")).toBe(true);
    expect(isValidWebhookUrl("http://hooks.zapier.com/hooks/catch/1234/abcd/")).toBe(false);
    expect(isValidWebhookUrl("https://127.0.0.1/hook")).toBe(false);
    expect(isValidWebhookUrl("https://localhost:8080/hook")).toBe(false);
    expect(isValidWebhookUrl("https://192.168.1.10/hook")).toBe(false);
  });

  it("validates webhook drafts for name, url, and trigger events", () => {
    const errors = validateWebhookDraft({
      name: "  ",
      targetType: "zapier",
      url: "http://bad.example.com",
      events: [],
    });
    expect(Object.keys(errors)).toEqual(["name", "url", "events"]);
  });
});
