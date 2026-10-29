"use client";

import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface TagBadgeProps {
  tag: {
    id: string;
    name: string;
    color: string;
  };
  onRemove?: () => void;
  size?: "sm" | "md";
  className?: string;
}

export function TagBadge({ tag, onRemove, size = "sm", className }: TagBadgeProps) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "inline-flex items-center gap-1 text-foreground border-border bg-muted",
        size === "sm" ? "text-xs px-2 py-0.5" : "text-sm px-2.5 py-1",
        className
      )}
      style={{ borderLeft: `3px solid ${tag.color}` }}
    >
      <span>{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Удалить метку «${tag.name}»`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="ml-1 hover:bg-black/20 rounded-full p-0.5 transition-colors"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </Badge>
  );
}
