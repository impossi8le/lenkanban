import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTaskViewFocus } from "./useTaskViewFocus";

afterEach(() => { cleanup(); document.body.replaceChildren(); });

function fixture() {
  const opener = document.createElement("button");
  opener.textContent = "Открыть задачу";
  document.body.append(opener);
  const panel = document.createElement("aside");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Детали задачи");
  panel.setAttribute("aria-modal", "true");
  const close = document.createElement("button");
  panel.append(close);
  const callback = vi.fn(() => { document.body.append(panel); close.focus(); });
  return { opener, panel, callback };
}

it("restores the connected task opener after the routed panel unmounts", async () => {
  const f = fixture();
  const hook = renderHook(() => useTaskViewFocus(f.callback));
  await act(async () => hook.result.current("task-a", f.opener));
  expect(f.callback).toHaveBeenCalledWith("task-a");
  expect(f.panel.contains(document.activeElement)).toBe(true);
  f.panel.remove();
  await waitFor(() => expect(f.opener).toHaveFocus());
});

it("keeps the opener handler stable across parent callback changes and calls the latest callback", async () => {
  const f = fixture();
  const next = vi.fn(f.callback);
  const hook = renderHook(({ callback }) => useTaskViewFocus(callback), {
    initialProps: { callback: f.callback },
  });
  const original = hook.result.current;
  await act(async () => original("task-a", f.opener));
  hook.rerender({ callback: next });
  expect(hook.result.current).toBe(original);
  f.panel.remove();
  await waitFor(() => expect(f.opener).toHaveFocus());
  await act(async () => hook.result.current("task-b", f.opener));
  expect(next).toHaveBeenCalledWith("task-b");
});

it("does not steal focus from another control or replacement modal", async () => {
  const f = fixture();
  const hook = renderHook(() => useTaskViewFocus(f.callback));
  await act(async () => hook.result.current("task-a", f.opener));
  const other = document.createElement("button");
  document.body.append(other);
  other.focus();
  f.panel.remove();
  await act(async () => undefined);
  expect(other).toHaveFocus();

  await act(async () => hook.result.current("task-b", f.opener));
  const replacement = document.createElement("div");
  replacement.setAttribute("role", "dialog");
  replacement.setAttribute("aria-modal", "true");
  f.panel.remove();
  document.body.append(replacement);
  await act(async () => undefined);
  expect(f.opener).not.toHaveFocus();
});

it("disconnects when the view unmounts and tolerates a click that opens no dialog", async () => {
  const f = fixture();
  const hook = renderHook(() => useTaskViewFocus(f.callback));
  await act(async () => hook.result.current("task-a", f.opener));
  hook.unmount();
  f.panel.remove();
  await act(async () => undefined);
  expect(f.opener).not.toHaveFocus();
  const noDialog = renderHook(() => useTaskViewFocus(vi.fn()));
  await act(async () => noDialog.result.current("task-b", f.opener));
  expect(f.opener).toHaveFocus();
  noDialog.unmount();
});
