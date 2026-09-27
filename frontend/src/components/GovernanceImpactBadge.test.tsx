import React from "react";
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { GovernanceImpactBadge } from "./GovernanceImpactBadge";

describe("GovernanceImpactBadge", () => {
  it("renders low impact badge", () => {
    const { container } = render(<GovernanceImpactBadge impact="low" />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it("renders medium impact badge", () => {
    const { container } = render(<GovernanceImpactBadge impact="medium" />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it("renders high impact badge", () => {
    const { container } = render(<GovernanceImpactBadge impact="high" />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it("renders critical impact badge", () => {
    const { container } = render(<GovernanceImpactBadge impact="critical" />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
