export interface KanbanColumnRecord {
  id: string;
  position: number;
  [key: string]: unknown;
}

export interface KanbanTaskRecord {
  id: string;
  columnId: string;
  position: number;
  version: number;
  [key: string]: unknown;
}

export interface KanbanBoardState {
  columnOrder: string[];
  taskIdsByColumn: Record<string, string[]>;
  tasksById: Record<string, KanbanTaskRecord>;
}

export interface MoveTaskCommandDraft {
  toColumnId: string;
  beforeTaskId: string | null;
  afterTaskId: string | null;
}

export interface NormalizeBoardInput {
  columns: KanbanColumnRecord[];
  tasks: KanbanTaskRecord[];
}
