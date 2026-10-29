"use client";

import { Calendar } from "@/components/ui/calendar";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { calendarDateToDayKey, dayKeyToCalendarDate } from "./my-day-dates";

type Props = {
  date: string;
  today: string;
  month: Date;
  onMonthChange: (month: Date) => void;
  onSelect: (date: string) => void;
};

/** Both desktop and the mobile popover share the same accessible date picker. */
export function MyDayCalendar({ date, today, month, onMonthChange, onSelect }: Props) {
  const todayDate = dayKeyToCalendarDate(today);
  return <Calendar
    mode="single" month={month} onMonthChange={onMonthChange}
    selected={dayKeyToCalendarDate(date)} today={todayDate}
    endMonth={todayDate} disabled={{ after: todayDate }}
    onSelect={selected => { if (selected) onSelect(calendarDateToDayKey(selected)); }}
    className="w-full p-0"
    classNames={{
      months: "relative flex w-full flex-col gap-4",
      month: "w-full space-y-3",
      month_caption: "flex min-h-11 items-center justify-center px-12",
      caption_label: "text-xl font-semibold capitalize",
      nav: "pointer-events-none absolute inset-x-0 top-0 z-10 flex min-h-11 items-center justify-between",
      button_previous: cn(buttonVariants({ variant: "outline" }), "pointer-events-auto h-11 min-h-11 w-11 min-w-11 bg-transparent p-0"),
      button_next: cn(buttonVariants({ variant: "outline" }), "pointer-events-auto h-11 min-h-11 w-11 min-w-11 bg-transparent p-0"),
      month_grid: "w-full table-fixed border-collapse",
      weekdays: "h-10",
      weekday: "w-11 text-center text-sm font-medium text-muted-foreground",
      week: "h-12",
      day: "relative h-12 min-h-11 w-11 min-w-11 p-0 text-center focus-within:z-20",
      day_button: cn(buttonVariants({ variant: "ghost" }), "mx-auto h-11 min-h-11 w-11 min-w-11 rounded-lg border border-border p-0 text-[18px] font-medium disabled:text-muted-foreground disabled:opacity-50"),
    }}
  />;
}
