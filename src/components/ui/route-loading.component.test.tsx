import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RouteLoading, type RouteLoadingVariant } from "./route-loading";

afterEach(cleanup);

describe("RouteLoading", () => {
  it("announces loading with a polite live status and an accessible name", () => {
    render(<RouteLoading />);

    const status = screen.getByRole("status", { name: "Загрузка…" });
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-busy", "true");
  });

  it("uses the route-specific Russian label", () => {
    render(<RouteLoading variant="board" label="Загрузка доски…" />);

    expect(screen.getByRole("status", { name: "Загрузка доски…" })).toBeInTheDocument();
  });

  it.each<RouteLoadingVariant>(["board", "task", "table", "analytics", "form", "messages"])(
    "renders a decorative skeleton for the %s variant",
    (variant) => {
      const { container } = render(<RouteLoading variant={variant} />);

      const status = screen.getByRole("status");
      const skeleton = status.querySelector("[aria-hidden='true']");
      expect(skeleton).not.toBeNull();
      expect(skeleton!.childElementCount).toBeGreaterThan(0);
      expect(container.textContent).toBe("");
    }
  );
});
