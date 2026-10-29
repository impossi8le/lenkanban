"use client";

import * as React from "react";

export interface QueueUnseenFilterProps {
  unseenOnly: boolean;
  onChange: (unseenOnly: boolean) => void;
  count?: number;
  disabled?: boolean;
  className?: string;
}

function formatUnseenLabel(count?: number): string {
  const isValidCount =
    typeof count === "number" &&
    Number.isFinite(count) &&
    Number.isInteger(count) &&
    count >= 0;

  if (!isValidCount) {
    return "Новые в очереди";
  }

  const displayCount = count === 0 ? 0 : count;
  return `Новые в очереди · ${displayCount}`;
}

export function QueueUnseenFilter({
  unseenOnly,
  onChange,
  count,
  disabled = false,
  className,
}: QueueUnseenFilterProps) {
  const unseenLabel = formatUnseenLabel(count);
  const wrapperClass = className
    ? `request-board-filter-field ${className}`
    : "request-board-filter-field";

  return (
    <div className={wrapperClass}>
      <span>Просмотр</span>
      <div
        className="request-board-segment"
        role="group"
        aria-label="Фильтр просмотра"
      >
        <button
          type="button"
          className="min-h-11"
          aria-pressed={!unseenOnly}
          disabled={disabled}
          onClick={() => {
            if (!disabled) {
              onChange(false);
            }
          }}
        >
          Все
        </button>
        <button
          type="button"
          className="min-h-11"
          aria-pressed={unseenOnly}
          disabled={disabled}
          onClick={() => {
            if (!disabled) {
              onChange(true);
            }
          }}
        >
          {unseenLabel}
        </button>
      </div>
    </div>
  );
}

export default QueueUnseenFilter;
