// Test-only, bounded metadata. Never retain URLs, headers, bodies or error text.
const PHASES = new Set(["setup", "registration", "verification", "sign_in", "promotion", "project_create", "project_heading", "task_create", "task_list", "task_open", "title_save", "saved_status", "reload", "reopen", "complete"]);
const METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]);
const CATEGORIES = new Set(["auth", "project_create", "project_api", "task_api", "task_details_api", "board_route", "task_route", "client_chunk"]);
function errorClass(error) { return error?.name === "TimeoutError" ? "timeout" : error?.name === "AbortError" ? "aborted" : error ? "error" : "none"; }
function classify(request) {
  try {
    const url = new URL(request.url());
    const p = url.pathname;
    let category;
    if (/^\/api\/auth\/(?:register|callback\/credentials|session|csrf|providers)$/.test(p)) category = "auth";
    else if (/^\/api\/project-templates\/[^/]+\/use$/.test(p) || p === "/api/projects" && request.method() === "POST") category = "project_create";
    else if (p === "/api/projects") category = "project_api";
    else if (/^\/api\/projects\/[^/]+$/.test(p)) category = "project_api";
    else if (/^\/api\/tasks\/[^/]+$/.test(p)) category = url.searchParams.get("view") === "details" ? "task_details_api" : "task_api";
    else if (p === "/api/tasks") category = "task_api";
    else if (/^\/projects\/[^/]+\/board$/.test(p)) category = "board_route";
    else if (/^\/projects\/[^/]+\/tasks\/[^/]+$/.test(p)) category = "task_route";
    else if (p.startsWith("/_next/static/") && request.resourceType() === "script") category = "client_chunk";
    if (!category) return null;
    return { category, method: METHODS.has(request.method()) ? request.method() : "OTHER", rsc: url.searchParams.has("_rsc"), navigation: request.isNavigationRequest() === true };
  } catch { return null; }
}
function startRegistrationDiagnostic(page) {
  const started = performance.now();
  let phase = "setup", active = true, dropped = 0;
  const records = [], requests = new WeakMap();
  const elapsed = () => Math.max(0, Math.min(120000, Math.round(performance.now() - started)));
  function append(event, entry, status = null, error = "none") {
    if (!active || !entry || !CATEGORIES.has(entry.category)) return;
    if (records.length === 256) { records.shift(); dropped++; }
    records.push({ event, category: entry.category, method: entry.method, rsc: entry.rsc, navigation: entry.navigation,
      elapsedMs: elapsed(), requestElapsedMs: Math.max(0, elapsed() - entry.started), phase,
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null, errorClass: error });
  }
  const request = value => { try { const entry = classify(value); if (entry) { entry.started = elapsed(); requests.set(value, entry); append("request", entry); } } catch { /* No effect on test. */ } };
  const response = value => {
    try {
      const entry = requests.get(value.request());
      if (!entry) return;
      const status = value.status(); append("response", entry, status);
      void Promise.resolve().then(() => value.finished()).then(error => append("body_finished", entry, status, errorClass(error)), () => append("body_finished", entry, status, "error"));
    } catch { /* No effect on test. */ }
  };
  const failed = value => { try { append("request_failed", requests.get(value), null, "request_failed"); } catch { /* No error text. */ } };
  page.on("request", request); page.on("response", response); page.on("requestfailed", failed);
  const stop = () => {
    active = false;
    for (const [event, listener] of [["request", request], ["response", response], ["requestfailed", failed]]) {
      try { page.off(event, listener); } catch { /* Teardown must not replace the original failure. */ }
    }
  };
  return {
    phase(value) { if (PHASES.has(value)) phase = value; },
    stop,
    async failure({ expectedEmail, projectName, taskId }) {
      // Stop collecting before the extra read-only probes or fixture cleanup.
      const report = { schemaVersion: 1, phase, elapsedMs: elapsed(), dropped, records: records.map(value => ({ ...value })),
        actorSessionMatches: null, sessionStatus: null, taskGetStatus: null, panelPresent: null, panelVisible: null,
        savedStatusPresent: null, savingStatusPresent: null, projectHeadingVisible: null, probeErrorClass: "none" };
      stop();
      let timer;
      const probe = async () => {
        await Promise.allSettled([
          (async () => {
            if (typeof expectedEmail !== "string") return;
            const result = await page.request.get("/api/auth/session", { timeout: 1500 });
            try { report.sessionStatus = result.status(); const body = await result.json(); report.actorSessionMatches = typeof body?.user?.email === "string" && body.user.email === expectedEmail; }
            finally { await result.dispose(); }
          })().catch(error => { report.probeErrorClass = errorClass(error); }),
          (async () => {
            if (typeof taskId !== "string") return;
            const result = await page.request.get(`/api/tasks/${encodeURIComponent(taskId)}?view=details`, { timeout: 1500 });
            try { report.taskGetStatus = result.status(); } finally { await result.dispose(); }
          })().catch(error => { report.probeErrorClass = errorClass(error); }),
          (async () => {
            const panel = page.getByRole("dialog", { name: "Детали задачи", exact: true });
            report.panelPresent = (await panel.count()) > 0;
            report.panelVisible = await panel.isVisible();
            report.savedStatusPresent = (await panel.getByRole("status", { name: "Название сохранено", exact: true }).count()) > 0;
            report.savingStatusPresent = (await panel.getByRole("status", { name: "Сохранение названия", exact: true }).count()) > 0;
            if (typeof projectName === "string") report.projectHeadingVisible = await page.getByRole("heading", { name: projectName, exact: true }).isVisible();
          })().catch(error => { report.probeErrorClass = errorClass(error); }),
        ]);
      };
      try { await Promise.race([probe(), new Promise(resolve => { timer = setTimeout(() => { report.probeErrorClass = "timeout"; resolve(); }, 2000); })]); }
      catch { report.probeErrorClass = "error"; }
      finally { clearTimeout(timer); }
      // The serializer only receives our fixed schema, never an Error/Request.
      return JSON.stringify(report);
    },
  };
}
module.exports = { startRegistrationDiagnostic, classify, errorClass };
