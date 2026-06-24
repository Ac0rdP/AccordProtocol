import { render, screen } from "@testing-library/react";
import { CreateProposalModal } from "./CreateProposalModal";

describe("CreateProposalModal - Proposer Field", () => {
  const defaultProps = {
    walletAddress: "GBXGJZUFVB2F3J2Y5B4S4V6JWYD2H4O3T7XQZT5XKV6S2J5N6Z2Z2Z2Z",
    onClose: jest.fn(),
    onSubmitted: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("Connected wallet opens modal and shows Proposer field", () => {
    render(<CreateProposalModal {...defaultProps} />);
    expect(screen.getByText("Proposer")).toBeInTheDocument();
  });

  it("Address is truncated to first 6 and last 4", () => {
    render(<CreateProposalModal {...defaultProps} />);
    // "GBXGJZ" ... "Z2Z2"
    expect(screen.getByText("GBXGJZ…Z2Z2")).toBeInTheDocument();
  });

  it("Proposer cannot be edited (renders as read-only element, not input)", () => {
    render(<CreateProposalModal {...defaultProps} />);
    // The "Proposer" label is followed by a div, not an input.
    // Testing library's getByLabelText will fail if it's not an input.
    expect(() => screen.getByLabelText("Proposer")).toThrow();
  });

  it("No wallet connected displays 'Not connected'", () => {
    render(<CreateProposalModal {...defaultProps} walletAddress={null} />);
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });
});
