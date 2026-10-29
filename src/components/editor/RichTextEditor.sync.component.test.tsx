import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RichTextEditor } from "./RichTextEditor";

afterEach(cleanup);

it("does not report server content synchronization as user input", async () => {
  const onChange = vi.fn();
  const view = render(<RichTextEditor content="<p>Исходное</p>" onChange={onChange} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable="true"]')).toBeTruthy());
  view.rerender(<RichTextEditor content="<p>Изменение коллеги</p>" onChange={onChange} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable="true"]')).toHaveTextContent("Изменение коллеги"));
  expect(onChange).not.toHaveBeenCalled();
});
