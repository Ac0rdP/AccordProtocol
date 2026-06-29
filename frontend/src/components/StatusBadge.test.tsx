import { render } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it("renders pending status", () => {
    const { container } = render(<StatusBadge status="pending" />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it("renders ready status", () => {
    const { container } = render(<StatusBadge status="ready" />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it("renders executed status", () => {
    const { container } = render(<StatusBadge status="executed" />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it("renders expired status", () => {
    const { container } = render(<StatusBadge status="expired" />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it("renders revoked status", () => {
    const { container } = render(<StatusBadge status="revoked" />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
