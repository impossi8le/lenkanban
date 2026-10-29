import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type RouteLoadingVariant =
  | "board"
  | "task"
  | "table"
  | "analytics"
  | "form"
  | "messages";

const CARD_CLASS = "rounded-xl border bg-card p-4 shadow-sm";
const ROW_CLASS = "flex items-center gap-3 rounded-lg border bg-card p-3";

function BoardSkeleton() {
  return (
    <div className="flex min-h-[60vh] flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-8 w-48" />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
      <div className="flex gap-4 overflow-hidden pb-4">
        {[0, 1, 2, 3].map((column) => (
          <div
            key={column}
            className="flex w-[300px] shrink-0 flex-col gap-3 rounded-xl border bg-card/60 p-3"
          >
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-6 rounded-full" />
            </div>
            {[0, 1, 2].map((card) => (
              <Skeleton key={card} className="h-20 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function TaskSkeleton() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-8 w-2/3 max-w-md" />
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="h-6 w-28 rounded-full" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className={cn(CARD_CLASS, "space-y-3")}>
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-32 w-full" />
        </div>
        <div className={cn(CARD_CLASS, "space-y-3")}>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-9 w-full" />
        </div>
      </div>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="w-full min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className={cn(CARD_CLASS, "space-y-3")}>
        <Skeleton className="h-5 w-full max-w-sm" />
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <div key={row} className={ROW_CLASS}>
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="ml-auto h-4 w-24" />
            <Skeleton className="h-8 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <Skeleton className="h-8 w-64" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((stat) => (
          <div key={stat} className={cn(CARD_CLASS, "space-y-2")}>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-8 w-16" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {[0, 1].map((chart) => (
          <div key={chart} className={cn(CARD_CLASS, "space-y-3")}>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-56 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

function FormSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <Skeleton className="h-8 w-48" />
      <div className={cn(CARD_CLASS, "space-y-4")}>
        {[0, 1, 2, 3].map((field) => (
          <div key={field} className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
        <Skeleton className="h-10 w-40" />
      </div>
    </div>
  );
}

function MessagesSkeleton() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>
      {[0, 1, 2].map((group) => (
        <div key={group} className={cn(CARD_CLASS, "space-y-3")}>
          <Skeleton className="h-4 w-40" />
          {[0, 1].map((row) => (
            <div key={row} className={ROW_CLASS}>
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-5 w-8 rounded-full" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function VariantSkeleton({ variant }: { variant: RouteLoadingVariant }) {
  switch (variant) {
    case "board":
      return <BoardSkeleton />;
    case "task":
      return <TaskSkeleton />;
    case "analytics":
      return <AnalyticsSkeleton />;
    case "form":
      return <FormSkeleton />;
    case "messages":
      return <MessagesSkeleton />;
    case "table":
    default:
      return <TableSkeleton />;
  }
}

export function RouteLoading({
  variant = "table",
  label = "Загрузка…",
  className,
}: {
  variant?: RouteLoadingVariant;
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
      className={cn("w-full min-w-0 p-4 sm:p-6", className)}
    >
      <div aria-hidden="true">
        <VariantSkeleton variant={variant} />
      </div>
    </div>
  );
}
