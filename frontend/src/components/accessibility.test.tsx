import React from "react";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { LoadingState } from "./LoadingState";

describe("shared component accessibility", () => {
  it.each([
    ["error banner", <ErrorState message="Unable to load" onRetry={() => {}} variant="banner" />],
    ["error page", <ErrorState message="Unable to load" onRetry={() => {}} onDismiss={() => {}} />],
    ["empty state", <EmptyState title="No proposals" description="Create one to get started." />],
    ["loading state", <LoadingState message="Loading proposals" />],
  ])("has no axe violations in the %s state", async (_name, component) => {
    const { container } = render(component);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});