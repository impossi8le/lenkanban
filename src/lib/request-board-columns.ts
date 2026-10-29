// Shared request workflow; names are presentation, keys remain stable.
export const DEFAULT_BOARD_COLUMNS = [
  { name: "Новые", color: "#d92d3a", position: 0, workflowKey: "TODO" },
  { name: "В работе", color: "#246ed1", position: 1, workflowKey: "IN_PROGRESS" },
  { name: "Ждём сотрудника", color: "#d69a20", position: 2, workflowKey: "NEEDS_INFO" },
  { name: "Решено", color: "#168454", position: 3, workflowKey: "REVIEW" },
  { name: "Закрыто", color: "#168454", position: 4, workflowKey: "DONE" },
];
