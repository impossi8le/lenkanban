import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useContext } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MotionConfigContext } from "motion/react";
import postcss from "postcss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  KanbanCardView,
  type TaskType,
} from "@/components/kanban/Card";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { ThemeProvider } from "@/providers/theme-provider";

afterEach(cleanup);

const originalMatchMedia = window.matchMedia;

beforeAll(() => {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }) as MediaQueryList;
});

afterAll(() => {
  window.matchMedia = originalMatchMedia;
});

const highPriorityTask: TaskType = {
  id: "task-theme-contract",
  title: "Проверить темную тему",
  columnId: "doing",
  priority: "HIGH",
  position: 1024,
  projectId: "project-theme-contract",
  version: 1,
};

describe("Kanban theme contract", () => {
  it("uses semantic card tokens for a priority card inside dark mode", () => {
    render(
      <div className="dark">
        <KanbanCardView task={highPriorityTask} onOpen={() => undefined} />
      </div>,
    );

    const card = screen
      .getByText("Проверить темную тему")
      .closest("[data-task-id]");

    expect(card).toHaveAttribute("data-priority", "HIGH");
    expect(card).toHaveClass("bg-card", "text-card-foreground", "border-2", "border-red-500");
  });

  it("gives the theme trigger a stable Russian accessible name", () => {
    render(<ThemeToggle />);

    expect(
      screen.getByRole("button", { name: "Выбрать тему" }),
    ).toBeInTheDocument();
  });

  it("configures Motion to respect the user's reduced-motion preference", () => {
    function MotionConfigProbe(): React.ReactElement {
      const config = useContext(MotionConfigContext);
      return (
        <output data-testid="motion-config">
          {config.reducedMotion}
        </output>
      );
    }

    render(
      <ThemeProvider>
        <MotionConfigProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("motion-config")).toHaveTextContent("user");
  });

  it("uses the foreground token for calendar text while preserving the muted background token", () => {
    const css = postcss.parse(
      readFileSync(
        resolve(process.cwd(), "src/app/globals.css"),
        "utf8",
      ),
    );
    const declaration = (selector: string, property: string) => {
      let value: string | undefined;
      css.walkRules((rule) => {
        if (rule.selectors.includes(selector)) {
          rule.walkDecls(property, (decl) => {
            value = decl.value;
          });
        }
      });
      return value;
    };

    for (const selector of [
      ".rbc-off-range",
      ".rbc-date-cell",
      ".rbc-agenda-date-cell",
      ".rbc-agenda-time-cell",
    ]) {
      expect(declaration(selector, "color")).toBe(
        "var(--muted-foreground)",
      );
    }
    expect(declaration(".rbc-off-range-bg", "background-color")).toContain(
      "var(--muted)",
    );
    expect(declaration(".rbc-off-range-bg", "background-color")).not.toContain(
      "var(--muted-foreground)",
    );
    expect(declaration(".rbc-off-range", "opacity")).toBeUndefined();
    expect(declaration(".dark .rbc-off-range", "opacity")).toBeUndefined();
  });
});
