import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-md bg-secondary/30", className)} />
  );
}

export function SkeletonCard() {
  return (
    <div className="bg-card rounded-xl border p-4 shadow-sm">
      <div className="flex justify-between items-start mb-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-12" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

export function SkeletonCardList({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

export function SkeletonColumn() {
  return (
    <div className="flex flex-col flex-shrink-0 w-[320px] bg-secondary/30 rounded-xl p-3 h-full border">
      <div className="flex items-center justify-between mb-4 px-1">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-5 w-6 rounded-full" />
        </div>
        <Skeleton className="h-6 w-6 rounded" />
      </div>
      <div className="flex-1 space-y-3 overflow-hidden">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    </div>
  );
}

export function SkeletonBoard() {
  return (
    <div className="flex gap-4 h-full items-stretch overflow-x-auto pb-6">
      {Array.from({ length: 4 }).map((_, i) => (
        <SkeletonColumn key={i} />
      ))}
    </div>
  );
}
