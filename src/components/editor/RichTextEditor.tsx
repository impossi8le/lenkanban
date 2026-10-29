"use client";

import * as React from "react";
import { useEditor, useEditorState, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Code,
  Quote,
  Undo,
  Redo,
  Check,
  Loader2,
} from "lucide-react";

interface RichTextEditorProps {
  content: string;
  onChange: (content: string) => void;
  placeholder?: string;
  className?: string;
  editable?: boolean;
  onSave?: () => void;
  isSaving?: boolean;
  isSaved?: boolean;
  hasUnsavedChanges?: boolean;
}

function readToolbarState(current: Editor | null) {
  return current ? {
    bold: current.isActive("bold"),
    italic: current.isActive("italic"),
    bulletList: current.isActive("bulletList"),
    orderedList: current.isActive("orderedList"),
    codeBlock: current.isActive("codeBlock"),
    blockquote: current.isActive("blockquote"),
    canBold: current.can().toggleBold(),
    canItalic: current.can().toggleItalic(),
    canUndo: current.can().undo(),
    canRedo: current.can().redo(),
  } : null;
}

export function RichTextEditor({
  content,
  onChange,
  placeholder = "Добавьте описание...",
  className,
  editable = true,
  onSave,
  isSaving = false,
  isSaved = false,
  hasUnsavedChanges = false,
}: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3],
        },
      }),
      Placeholder.configure({
        placeholder,
      }),
    ],
    content,
    editable,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "Описание заявки",
        "aria-multiline": "true",
        "aria-readonly": String(!editable),
        class: cn(
          "prose prose-sm dark:prose-invert max-w-none min-h-[120px] break-words px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-b-lg",
          editable && onSave && "pb-14",
          "[&_p]:my-1 [&_h1]:text-lg [&_h1]:font-bold [&_h2]:text-base [&_h2]:font-semibold",
          "[&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5",
          "[&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:bg-secondary [&_pre]:p-2 [&_pre]:rounded [&_code]:text-primary",
          "[&_blockquote]:border-l-2 [&_blockquote]:border-primary [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground"
        ),
      },
    },
  });

  const observedToolbarState = useEditorState({
    editor,
    selector: ({ editor: current }) => readToolbarState(current),
  });
  // The subscription's initial snapshot can still be null while the editor
  // already exists. Mount EditorContent so its first transaction can be observed.
  const toolbarState = observedToolbarState ?? readToolbarState(editor);

  React.useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable, false);
  }, [editable, editor]);

  React.useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content, { emitUpdate: false });
    }
  }, [content, editor]);

  if (!editor || !toolbarState) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label="Загрузка редактора…"
        className={cn("min-w-0 rounded-lg border bg-background", className)}
      >
        <div aria-hidden="true" className="space-y-3 p-3">
          <div className="flex flex-wrap gap-1">
            {[0, 1, 2, 3, 4].map((button) => (
              <Skeleton key={button} className="h-7 w-7" />
            ))}
          </div>
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className={cn("min-w-0 rounded-lg border bg-background", className)}>
      {editable && (
        <div role="group" aria-label="Форматирование текста" className="flex flex-wrap items-center gap-0.5 border-b p-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Жирный"
            title="Жирный"
            aria-pressed={toolbarState.bold}
            onClick={() => {
              // Normalize an initial trailing code block before setting stored
              // marks; its appended paragraph would otherwise clear the mark.
              if (editor.state.selection.empty) {
                editor.commands.focus();
                editor.commands.toggleBold();
              } else {
                editor.chain().focus().toggleBold().run();
              }
            }}
            disabled={!toolbarState.canBold}
          >
            <Bold className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Курсив"
            title="Курсив"
            aria-pressed={toolbarState.italic}
            onClick={() => {
              if (editor.state.selection.empty) {
                editor.commands.focus();
                editor.commands.toggleItalic();
              } else {
                editor.chain().focus().toggleItalic().run();
              }
            }}
            disabled={!toolbarState.canItalic}
          >
            <Italic className="h-3.5 w-3.5" />
          </Button>
          <div className="mx-1 h-4 w-px bg-border" />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Маркированный список"
            title="Маркированный список"
            aria-pressed={toolbarState.bulletList}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Нумерованный список"
            title="Нумерованный список"
            aria-pressed={toolbarState.orderedList}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <ListOrdered className="h-3.5 w-3.5" />
          </Button>
          <div className="mx-1 h-4 w-px bg-border" />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Блок кода"
            title="Блок кода"
            aria-pressed={toolbarState.codeBlock}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          >
            <Code className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Цитата"
            title="Цитата"
            aria-pressed={toolbarState.blockquote}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            <Quote className="h-3.5 w-3.5" />
          </Button>
          <div className="mx-1 h-4 w-px bg-border" />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Отменить"
            title="Отменить"
            onClick={() => editor.chain().focus().undo().run()}
            disabled={!toolbarState.canUndo}
          >
            <Undo className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Повторить"
            title="Повторить"
            onClick={() => editor.chain().focus().redo().run()}
            disabled={!toolbarState.canRedo}
          >
            <Redo className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      <div className="relative">
        <EditorContent editor={editor} />
        {editable && onSave && (
          <div className="absolute bottom-2 right-2">
            <Button
              type="button"
              size="sm"
              variant={hasUnsavedChanges ? "default" : "secondary"}
              className={cn(
                // Keep the semantic variant colors at full opacity in disabled
                // pending/saved states, and add a focus outline outside the
                // unsaved ring so focus stays visible in every state.
                "h-8 shadow-sm transition-all disabled:opacity-100 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring",
                hasUnsavedChanges && "ring-2 ring-primary ring-offset-2 ring-offset-background"
              )}
              onClick={onSave}
              aria-busy={isSaving}
              disabled={isSaving || isSaved || !hasUnsavedChanges}
            >
              {isSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {isSaved && <Check className="mr-1.5 h-3.5 w-3.5" />}
              {isSaving ? "Сохранение…" : isSaved ? "Сохранено" : "Сохранить"}
            </Button>
          </div>
        )}
        {editable && onSave && (
          <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {isSaving ? "Сохранение…" : isSaved ? "Сохранено" : ""}
          </span>
        )}
      </div>
    </div>
  );
}
