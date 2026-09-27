import React from "react";
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { WhaleWarningBadge } from "./WhaleWarningBadge";

describe("WhaleWarningBadge", () => {
  it("renders non-triggered (balanced) state", () => {
    const { container } = render(<WhaleWarningBadge triggered={false} />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it("renders triggered state with share percentage", () => {
    const { container } = render(
      <WhaleWarningBadge triggered={true} sharePct={65} thresholdPct={50} />
    );
    expect(container.firstChild).toMatchSnapshot();
  });
});
