import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import QRCode from "qrcode";
import { ShareQrCode } from "./ShareQrCode";

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn() } }));
const toDataURL = vi.mocked(QRCode.toDataURL) as unknown as ReturnType<typeof vi.fn>;

describe("ShareQrCode", () => {
  it("renders a downloadable QR code for the link", async () => {
    toDataURL.mockResolvedValue("data:image/png;base64,abc");
    render(<ShareQrCode url="https://app.example/proposals/12" name="proposal-12" />);
    expect(screen.getByText("Generating QR code…")).toBeInTheDocument();
    const img = await screen.findByRole("img", { name: /QR code for/ });
    expect(img).toHaveAttribute("src", "data:image/png;base64,abc");
    expect(screen.getByRole("link", { name: "Download QR" })).toHaveAttribute(
      "download",
      "proposal-12-qr.png",
    );
  });

  it("shows an error when generation fails", async () => {
    toDataURL.mockRejectedValue(new Error("too long"));
    render(<ShareQrCode url="https://app.example/x" name="x" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not generate QR code.");
  });

  it("shows an error when there is no link", () => {
    render(<ShareQrCode url="" name="empty" />);
    expect(screen.getByRole("alert")).toHaveTextContent("No link to share.");
  });
});
