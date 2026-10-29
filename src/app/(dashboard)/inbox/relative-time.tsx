"use client";

import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";

const UNAVAILABLE = "дата недоступна";

/**
 * Relative time depends on the browser clock and timezone, so rendering it on
 * the server would make the markup disagree with the client hydration pass.
 * The server (and the hydration render, which starts from the same `null`
 * label) emits a stable absolute date; the relative label replaces it only
 * after mount, in the browser.
 */
export function RelativeTime({ value }: { value: string | Date }) {
  const date = value instanceof Date ? value : new Date(value);
  const valid = Number.isFinite(date.getTime());
  const absolute = valid ? date.toISOString().slice(0, 10) : UNAVAILABLE;
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const parsed = value instanceof Date ? value : new Date(value);
    setLabel(
      Number.isFinite(parsed.getTime())
        ? formatDistanceToNow(parsed, { addSuffix: true, locale: ru })
        : UNAVAILABLE,
    );
  }, [value]);

  return (
    <time dateTime={valid ? date.toISOString() : undefined} title={valid ? date.toISOString() : undefined}>
      {label ?? absolute}
    </time>
  );
}
