import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { axe } from "jest-axe";
import postcss from "postcss";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RichTextEditor } from "./RichTextEditor";

const captured = vi.hoisted(() => ({ editor: null as Editor | null }));

// Keep the real editor, ProseMirror state, commands and content renderer. This
// seam only exposes the instance so selection changes need no browser layout.
vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  return {
    ...actual,
    EditorContent(props: React.ComponentProps<typeof actual.EditorContent>) {
      captured.editor = props.editor;
      return <actual.EditorContent {...props} />;
    },
  };
});

afterEach(() => {
  cleanup();
  captured.editor = null;
});

// The Save button relies on the real design tokens rather than an ad-hoc
// color. Parse the shipped theme values so dirty/pending/saved states are
// checked against the same CSS the application loads.
const designSystem = postcss.parse(
  readFileSync(resolve(process.cwd(), "src/app/design-system.css"), "utf8"),
);
function themeTokens(selector: string) {
  const values: Record<string, string> = {};
  designSystem.walkRules(selector, (rule) => {
    rule.walkDecls((declaration) => { values[declaration.prop] = declaration.value; });
  });
  return values;
}
// Both themes are resolved independently: :root for light and .dark overrides.
const themes = {
  light: themeTokens(":root"),
  dark: { ...themeTokens(":root"), ...themeTokens(".dark") },
} as const;

function luminance(hex: string) {
  const rgb = hex.slice(1).match(/.{2}/g)!.map((value) => parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(foreground: string, background: string) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

async function editorReady() {
  await screen.findByRole("textbox", { name: "Описание заявки" });
  expect(captured.editor).not.toBeNull();
  return captured.editor!;
}

describe("RichTextEditor accessible editing", () => {
  it("names all toolbar commands and retains unavailable history commands", async () => {
    render(<RichTextEditor content="<p>Описание</p>" onChange={vi.fn()} />);
    await editorReady();
    for (const name of ["Жирный", "Курсив", "Маркированный список", "Нумерованный список", "Блок кода", "Цитата", "Отменить", "Повторить"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("type", "button");
    }
    for (const name of ["Жирный", "Курсив", "Маркированный список", "Нумерованный список", "Блок кода", "Цитата"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
    }
    expect(screen.getByRole("button", { name: "Отменить" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Повторить" })).toBeDisabled();
  });

  it("tracks formatting when only the real editor selection changes", async () => {
    const onChange = vi.fn();
    render(<RichTextEditor content="<p><strong>Жирно</strong> обычно</p>" onChange={onChange} />);
    const editor = await editorReady();
    act(() => { editor.commands.setTextSelection(2); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Жирный" })).toHaveAttribute("aria-pressed", "true"));
    act(() => { editor.commands.setTextSelection(10); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Жирный" })).toHaveAttribute("aria-pressed", "false"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ["Жирный", "bold"],
    ["Курсив", "italic"],
  ])("preserves the first %s command when a trailing code block needs a paragraph", async (name, mark) => {
    render(<RichTextEditor content="<p>Текст</p><pre><code>code</code></pre>" onChange={vi.fn()} />);
    const editor = await editorReady();
    // Do not dispatch a preliminary selection transaction: the first command
    // must also work while StarterKit still needs to append its trailing node.
    expect(editor.state.selection.from).toBe(1);
    // jsdom has no Range geometry. Skip only scrolling, leaving focus and all
    // document/selection transactions real; setOptions dispatches no transaction.
    editor.setOptions({ editorProps: { handleScrollToSelection: () => true } });
    const button = screen.getByRole("button", { name });
    fireEvent.click(button);
    await waitFor(() => {
      expect(button).toHaveAttribute("aria-pressed", "true");
      expect(editor.isActive(mark)).toBe(true);
    });
  });

  it("updates pressed and history states after real document transactions", async () => {
    const onChange = vi.fn();
    render(<RichTextEditor content="<p>Описание</p>" onChange={onChange} />);
    const editor = await editorReady();
    act(() => { editor.commands.toggleBulletList(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Маркированный список" })).toHaveAttribute("aria-pressed", "true"));
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining("<ul>"));
    expect(screen.getByRole("button", { name: "Отменить" })).toBeEnabled();
    act(() => { editor.commands.undo(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Маркированный список" })).toHaveAttribute("aria-pressed", "false"));
    expect(onChange).toHaveBeenLastCalledWith("<p>Описание</p>");
    expect(screen.getByRole("button", { name: "Повторить" })).toBeEnabled();
  });

  it("calls save once and announces saving and saved states", async () => {
    const onSave = vi.fn();
    const props = { content: "<p>Описание</p>", onChange: vi.fn(), onSave, hasUnsavedChanges: true };
    const view = render(<RichTextEditor {...props} />);
    await editorReady();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onSave).toHaveBeenCalledTimes(1);

    view.rerender(<RichTextEditor {...props} isSaving />);
    const saving = screen.getByRole("button", { name: "Сохранение…" });
    expect(saving).toBeDisabled();
    expect(saving).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status")).toHaveTextContent("Сохранение…");
    expect(saving).not.toContainElement(screen.getByRole("status"));
    fireEvent.click(saving);
    expect(onSave).toHaveBeenCalledTimes(1);

    view.rerender(<RichTextEditor {...props} isSaved />);
    const saved = screen.getByRole("button", { name: "Сохранено" });
    expect(saved).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Сохранено");
    expect(saved).not.toContainElement(screen.getByRole("status"));
  });

  it("preserves readable content without editing or saving controls", async () => {
    render(<RichTextEditor content="<p>Только чтение</p>" onChange={vi.fn()} editable={false} onSave={vi.fn()} hasUnsavedChanges />);
    const textbox = await screen.findByRole("textbox", { name: "Описание заявки" });
    expect(textbox).toHaveTextContent("Только чтение");
    expect(textbox).toHaveAttribute("contenteditable", "false");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("updates editable and readonly accessibility when props change without reporting input", async () => {
    const props = { content: "<p>Сохранённое описание</p>", onChange: vi.fn() };
    const view = render(<RichTextEditor {...props} editable={false} />);
    const editor = await editorReady();
    const textbox = screen.getByRole("textbox", { name: "Описание заявки" });
    expect(textbox).toHaveAttribute("aria-readonly", "true");
    expect(textbox).toHaveAttribute("contenteditable", "false");
    expect(editor.isEditable).toBe(false);

    view.rerender(<RichTextEditor {...props} editable />);
    await waitFor(() => {
      expect(textbox).toHaveAttribute("aria-readonly", "false");
      expect(textbox).toHaveAttribute("contenteditable", "true");
      expect(editor.isEditable).toBe(true);
    });
    expect(screen.getByRole("button", { name: "Жирный" })).toBeVisible();

    view.rerender(<RichTextEditor {...props} editable={false} />);
    await waitFor(() => {
      expect(textbox).toHaveAttribute("aria-readonly", "true");
      expect(textbox).toHaveAttribute("contenteditable", "false");
      expect(editor.isEditable).toBe(false);
    });
    expect(textbox).toHaveTextContent("Сохранённое описание");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it.each([
    { name: "Курсив", mark: "italic", run: (editor: Editor) => editor.commands.toggleItalic() },
    { name: "Нумерованный список", mark: "orderedList", run: (editor: Editor) => editor.commands.toggleOrderedList() },
    { name: "Блок кода", mark: "codeBlock", run: (editor: Editor) => editor.commands.toggleCodeBlock() },
    { name: "Цитата", mark: "blockquote", run: (editor: Editor) => editor.commands.toggleBlockquote() },
  ])("reports the pressed state of $name after real commands", async ({ name, mark, run }) => {
    render(<RichTextEditor content="<p>Описание</p>" onChange={vi.fn()} />);
    const editor = await editorReady();
    const button = screen.getByRole("button", { name });
    expect(button).toHaveAttribute("aria-pressed", "false");

    act(() => { run(editor); });
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    expect(editor.isActive(mark)).toBe(true);

    act(() => { run(editor); });
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "false"));
    expect(editor.isActive(mark)).toBe(false);
  });

  it("keeps disabled history commands named and exposes their native unavailable state", async () => {
    render(<RichTextEditor content="<p>Описание</p>" onChange={vi.fn()} />);
    await editorReady();
    for (const name of ["Отменить", "Повторить"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAccessibleName(name);
      expect(button).toHaveAttribute("title", name);
      expect(button).toBeDisabled();
    }
  });

  const saveStates = [
    {
      state: "dirty", props: { hasUnsavedChanges: true }, name: "Сохранить",
      background: "--primary", foreground: "--primary-foreground",
      backgroundClass: "bg-primary", foregroundClass: "text-primary-foreground",
      disabled: false,
    },
    {
      state: "pending", props: { hasUnsavedChanges: true, isSaving: true }, name: "Сохранение…",
      background: "--primary", foreground: "--primary-foreground",
      backgroundClass: "bg-primary", foregroundClass: "text-primary-foreground",
      disabled: true,
    },
    {
      state: "saved", props: { isSaved: true }, name: "Сохранено",
      background: "--secondary", foreground: "--secondary-foreground",
      backgroundClass: "bg-secondary", foregroundClass: "text-secondary-foreground",
      disabled: true,
    },
  ] as const;

  it.each(saveStates)(
    "keeps the $state save button on semantic readable colors with a visible focus indicator",
    async ({ props, name, background, foreground, backgroundClass, foregroundClass, disabled }) => {
      render(<RichTextEditor content="<p>Описание</p>" onChange={vi.fn()} onSave={vi.fn()} {...props} />);
      await editorReady();
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAccessibleName(name);
      if (disabled) expect(button).toBeDisabled();
      else expect(button).toBeEnabled();

      expect(button.className).toContain(backgroundClass);
      expect(button.className).toContain(foregroundClass);
      expect(button.className).not.toMatch(/(^|\s)text-white(\s|$)/);
      expect(button.className).not.toContain("disabled:opacity-50");
      expect(button.className).toContain("disabled:opacity-100");
      expect(button.className).toContain("focus-visible:outline-solid");
      expect(button.className).toContain("focus-visible:outline-2");
      expect(button.className).toContain("focus-visible:outline-offset-4");
      expect(button.className).toContain("focus-visible:outline-ring");

      for (const theme of ["light", "dark"] as const) {
        expect(contrast(themes[theme][foreground], themes[theme][background]))
          .toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("has no serious or critical axe violations while editing", async () => {
    const { container } = render(
      <RichTextEditor content="<p>Описание</p>" onChange={vi.fn()} onSave={vi.fn()} hasUnsavedChanges />,
    );
    await editorReady();
    const results = await axe(container);
    expect(
      results.violations.filter((violation) =>
        violation.impact === "serious" || violation.impact === "critical"),
    ).toEqual([]);
  });
});
