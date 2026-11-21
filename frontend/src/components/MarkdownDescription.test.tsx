import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownDescription } from "./MarkdownDescription";

describe("MarkdownDescription", () => {
  it("renders common Markdown blocks while preserving plain text", () => {
    render(
      <MarkdownDescription text={"## Budget\nUse **bold** and `code`.\n\n- First\n- Second"} />,
    );

    expect(screen.getByRole("heading", { name: "Budget" })).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(screen.getByRole("list").children).toHaveLength(2);
  });

  it("does not interpret raw HTML or allow unsafe links", () => {
    const { container } = render(
      <MarkdownDescription
        text={'<img src=x onerror=alert(1)> [run](javascript:alert(1)) [docs](https://example.com)'}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a[href^='javascript:']")).toBeNull();
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
    expect(container.querySelector("p")).toHaveTextContent("run");
  });

  it("shows a plain-text fallback for an empty description", () => {
    render(<MarkdownDescription text=" " emptyMessage="No notes yet." />);
    expect(screen.getByText("No notes yet.")).toBeInTheDocument();
  });
});
