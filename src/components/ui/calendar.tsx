"use client";

import * as React from "react";
import { DayPicker } from "react-day-picker";
import { ru } from "react-day-picker/locale";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      locale={ru}
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "relative flex flex-col gap-4 sm:flex-row",
        month: "w-[252px] space-y-2",
        month_caption: "flex h-7 items-center justify-center px-8",
        caption_label: "text-sm font-medium",
        nav: "pointer-events-none absolute inset-x-0 top-0 z-10 flex h-7 items-center justify-between",
        button_previous: cn(
          buttonVariants({ variant: "outline" }),
          "pointer-events-auto h-7 w-7 bg-transparent p-0 text-muted-foreground aria-disabled:text-[var(--text-disabled)]"
        ),
        button_next: cn(
          buttonVariants({ variant: "outline" }),
          "pointer-events-auto h-7 w-7 bg-transparent p-0 text-muted-foreground aria-disabled:text-[var(--text-disabled)]"
        ),
        chevron: "h-4 w-4 fill-current",
        dropdowns: "flex items-center gap-1",
        dropdown_root: "relative inline-flex items-center",
        dropdown: "absolute inset-0 z-10 w-full cursor-pointer opacity-0",
        month_grid: "w-full table-fixed border-collapse",
        weekdays: "h-8",
        weekday: "w-9 text-center text-[0.8rem] font-normal text-muted-foreground",
        week: "h-9",
        day: "relative h-9 w-9 p-0 text-center text-sm focus-within:z-20",
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "h-9 w-9 p-0 font-normal disabled:text-muted-foreground disabled:opacity-100"
        ),
        range_start: "rounded-l-md bg-accent",
        range_end: "rounded-r-md bg-accent",
        selected:
          "[&:not(.day-range-middle)>button]:bg-primary [&:not(.day-range-middle)>button]:text-primary-foreground [&:not(.day-range-middle)>button:hover]:bg-primary [&:not(.day-range-middle)>button:hover]:text-primary-foreground",
        today: "[&:not([data-selected])>button]:bg-accent [&:not([data-selected])>button]:text-accent-foreground",
        outside: "text-muted-foreground",
        disabled: "text-muted-foreground",
        range_middle: "day-range-middle bg-accent [&>button]:rounded-none [&>button]:bg-accent [&>button]:text-accent-foreground",
        hidden: "invisible",
        ...classNames,
      }}
      {...props}
    />
  );
}
Calendar.displayName = "Calendar";

export { Calendar };
