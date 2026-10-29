import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { Inbox, FolderOpen, Search, CheckCircle2 } from "lucide-react";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ 
  icon, 
  title, 
  description, 
  action,
  className 
}: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 1, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className={cn("flex flex-col items-center justify-center py-12 px-4", className)}
    >
      {icon && (
        <motion.div
          initial={{ scale: 0.8, opacity: 1 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="mb-4 text-muted-foreground"
        >
          {icon}
        </motion.div>
      )}
      <h3 className="text-lg font-semibold text-foreground mb-2 text-center">
        {title}
      </h3>
      {description && (
        <p className="text-sm text-muted-foreground text-center max-w-xs">
          {description}
        </p>
      )}
      {action && (
        <motion.div 
          initial={{ opacity: 1, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mt-6"
        >
          {action}
        </motion.div>
      )}
    </motion.div>
  );
}

export function EmptyTasks() {
  return (
    <EmptyState
      icon={<Inbox className="w-12 h-12" />}
      title="Пока нет задач"
      description="Создайте первую задачу, чтобы начать работу с проектом."
    />
  );
}

export function EmptyColumn({ description = "Перетащите задачи сюда или создайте новую." }: { description?: string } = {}) {
  return (
    <EmptyState
      icon={<FolderOpen className="w-10 h-10" />}
      title="Колонка пуста"
      description={description}
    />
  );
}

export function EmptySearch() {
  return (
    <EmptyState
      icon={<Search className="w-10 h-10" />}
      title="Ничего не найдено"
      description="Попробуйте изменить фильтры или поисковый запрос."
    />
  );
}

export function EmptyCompleted() {
  return (
    <EmptyState
      icon={<CheckCircle2 className="w-10 h-10 text-green-500" />}
      title="Всё выполнено!"
      description="Нет незавершённых задач. Отличная работа!"
    />
  );
}
