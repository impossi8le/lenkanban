import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { compile } from "tailwindcss";
import { transform } from "lightningcss";
import { Command, CommandItem, CommandList } from "./command";

let stylesheet: HTMLStyleElement | undefined;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  stylesheet?.remove();
});

async function renderItem(disabled: boolean, onSelect: () => void) {
  render(<Command><CommandList><CommandItem disabled={disabled} onSelect={onSelect}>
    Открыть задачу
  </CommandItem></CommandList></Command>);
  const item = screen.getByRole("option");
  // Compile the actual production classes so pointer-event regressions are
  // observable. Flatten CSS nesting for jsdom, just as older browsers require.
  const compiler = await compile("@tailwind utilities;");
  const css = compiler.build(Array.from(item.classList));
  stylesheet = document.createElement("style");
  stylesheet.textContent = transform({
    filename: "command-test.css", code: Buffer.from(css), targets: { chrome: 80 << 16 },
  }).code.toString();
  document.head.append(stylesheet);
  return item;
}

it("allows pointer selection when cmdk emits data-disabled=false", async () => {
  const onSelect = vi.fn();
  const item = await renderItem(false, onSelect);
  expect(item).toHaveAttribute("data-disabled", "false");
  expect(getComputedStyle(item).pointerEvents).toBe("auto");
  expect(getComputedStyle(item).opacity).not.toBe("0.5");
  await userEvent.click(item);
  expect(onSelect).toHaveBeenCalledOnce();
});

it("blocks pointer selection and dims truly disabled command items", async () => {
  const onSelect = vi.fn();
  const item = await renderItem(true, onSelect);
  expect(getComputedStyle(item).pointerEvents).toBe("none");
  expect(getComputedStyle(item).opacity).toBe("0.5");
  await expect(userEvent.click(item)).rejects.toThrow(/pointer-events/);
  expect(onSelect).not.toHaveBeenCalled();
});
