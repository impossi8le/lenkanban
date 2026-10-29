/** Shared presentation vocabulary for boards and current notification state.
 * Callers must provide only attachments visible to the current reader.
 */
type PhaseTask = { request?: { state?: string; beznalPhase?: string | null } | null; status?: string | null; column?: { name?: string | null } | null; attachments?: readonly unknown[] };
export function requestDisplayState(task: PhaseTask): string {
  if (task.request?.state) return task.request.state;
  if (task.status === "DRAFT") return "DRAFT";
  const name = task.column?.name?.toLocaleLowerCase() ?? "";
  if (/чернов/.test(name)) return "DRAFT";
  if (/закрыт/.test(name)) return "CLOSED";
  if (/отмен/.test(name)) return "CANCELLED";
  if (/решен|решён|решено/.test(name)) return "COMPLETED";
  if (/ожида|уточнен|уточнён|ждём|ждем/.test(name)) return "NEEDS_INFO";
  if (/работ/.test(name)) return "IN_PROGRESS";
  if (task.status === "DONE") return "COMPLETED";
  if (task.status === "IN_PROGRESS") return "IN_PROGRESS";
  if (task.status === "IN_REVIEW") return "NEEDS_INFO";
  return "SUBMITTED";
}
export function getRequestBoardPhase(task: PhaseTask, beznal = false, claim = false): { code: string; label: string } {
  const state = requestDisplayState(task);
  if (state === "DRAFT") return { code: state, label: "Черновик" };
  if (beznal) {
    if (["COMPLETED", "CLOSED", "CANCELLED"].includes(state)) return { code: "CLOSED", label: "Закрыто" };
    if (task.request?.beznalPhase === "WAITING") return { code: "WAITING", label: "Ждут обработки" };
    if (task.request?.beznalPhase === "INVOICED") return { code: "INVOICED", label: "Со счётом" };
    return task.attachments?.length ? { code: "INVOICED", label: "Со счётом" } : { code: "WAITING", label: "Ждут обработки" };
  }
  const code = state === "CANCELLED" ? "CLOSED" : claim && state === "NEEDS_INFO" ? "IN_PROGRESS" : state;
  const labels: Record<string, string> = { SUBMITTED: claim ? "Ждёт сотрудника" : "Новые", IN_PROGRESS: "В работе", NEEDS_INFO: "Ждём сотрудника", COMPLETED: "Решено", CLOSED: "Закрыто" };
  return { code, label: labels[code] ?? "Обращение" };
}
