import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { VotingPowerPreview } from "./VotingPowerPreview";

describe("VotingPowerPreview", () => {
  test("renders add_owner preview correctly", () => {
    const { container } = render(
      <VotingPowerPreview
        beforeWeight={5}
        afterWeight={6}
        totalWeight={6}
        type="add_owner"
        note="Note: Test owner addition."
      />
    );
    expect(container.textContent).toContain("Live Impact Preview");
    expect(container.textContent).toContain("Total voting weight will increase from 5 to 6");
    expect(container.textContent).toContain("New owner percentage share: 16.7%");
    expect(container.textContent).toContain("Note: Test owner addition.");
    expect(container).toMatchSnapshot();
  });

  test("renders remove_owner preview correctly with warning", () => {
    const { container } = render(
      <VotingPowerPreview
        beforeWeight={3}
        afterWeight={0}
        totalWeight={7}
        threshold={8}
        type="remove_owner"
        warning={{
          show: true,
          message: <p>Warning: Total weight falls below threshold!</p>,
        }}
      />
    );
    expect(container.textContent).toContain("Live Impact Preview");
    expect(container.textContent).toContain("Owner's current weight: 3");
    expect(container.textContent).toContain("Resulting total voting weight: 7 (threshold: 8)");
    expect(container.textContent).toContain("Warning: Total weight falls below threshold!");
    expect(container).toMatchSnapshot();
  });

  test("renders change_owner_weight preview correctly", () => {
    const { container } = render(
      <VotingPowerPreview
        beforeWeight={2}
        afterWeight={5}
        totalWeight={12}
        weightCapPct={50}
        type="change_owner_weight"
      />
    );
    expect(container.textContent).toContain("Live Impact Preview");
    expect(container.textContent).toContain("Resulting total voting weight: 12");
    expect(container.textContent).toContain("Owner's new share: 41.7% (cap: 50%)");
    expect(container).toMatchSnapshot();
  });
});
