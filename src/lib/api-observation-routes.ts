// Generated from root src/app/api/**/route.ts; drift is checked by the adjacent test.
export const API_ROUTE_TEMPLATES = [
  "/api/:...path",
  "/api/activities",
  "/api/problem-reports/:reportId/comment",
  "/api/tasks/:id/viewed",
  "/api/tasks/changes",
  "/api/admin/me",
  "/api/admin/organization/departments/:id",
  "/api/admin/organization/departments",
  "/api/admin/organization/group-privilege-assignments",
  "/api/admin/organization/groups/:id/leader",
  "/api/admin/organization/groups/:id/members",
  "/api/admin/organization/groups/:id",
  "/api/admin/organization/groups",
  "/api/admin/organization/history",
  "/api/admin/organization/people/:id",
  "/api/admin/organization/people",
  "/api/admin/organization/privilege-assignments",
  "/api/admin/organization/privilege-preview",
  "/api/admin/organization/privilege-profiles/:id",
  "/api/admin/organization/privilege-profiles",
  "/api/admin/organization/projects/:id/applicants",
  "/api/admin/organization/projects/:id",
  "/api/admin/organization/projects",
  "/api/admin/organization/roles",
  "/api/admin/projects",
  "/api/admin/telemetry/errors/:errorId",
  "/api/admin/telemetry",
  "/api/admin/telemetry/summary",
  "/api/admin/users/:id",
  "/api/admin/users",
  "/api/analytics",
  "/api/attachments/orphans/process",
  "/api/auth-login",
  "/api/auth/:...nextauth",
  "/api/auth/forgot-password",
  "/api/auth/register",
  "/api/auth/resend-verification",
  "/api/auth/reset-password",
  "/api/auth/sso/link",
  "/api/auth/sso/sync",
  "/api/auth/verify-email",
  "/api/automation-rules/:id",
  "/api/automation-rules",
  "/api/health",
  "/api/messages/threads",
  "/api/messages/unread",
  "/api/my-day",
  "/api/notifications/:id",
  "/api/notifications/mark-all-read",
  "/api/notifications",
  "/api/notifications/unread-count",
  "/api/organization/projects",
  "/api/project-templates/:id",
  "/api/project-templates/:id/use",
  "/api/project-templates",
  "/api/projects/:id/columns/:columnId",
  "/api/projects/:id/columns/reorder",
  "/api/projects/:id/columns",
  "/api/projects/:id/members/:memberId",
  "/api/projects/:id/members",
  "/api/projects/:id/request-recipients",
  "/api/projects/:id",
  "/api/projects/:id/task-permissions",
  "/api/projects",
  "/api/recurring-tasks/:id",
  "/api/recurring-tasks/process",
  "/api/recurring-tasks",
  "/api/request-directions",
  "/api/saved-views/:id",
  "/api/saved-views",
  "/api/tags/:id",
  "/api/tags",
  "/api/tasks/:id/assignees",
  "/api/tasks/:id/attachments",
  "/api/tasks/:id/checklist/:itemId",
  "/api/tasks/:id/checklist",
  "/api/tasks/:id/comments",
  "/api/tasks/:id/files/:fileId",
  "/api/tasks/:id/lifecycle",
  "/api/tasks/:id/messages/:messageId",
  "/api/tasks/:id/messages/mention-candidates",
  "/api/tasks/:id/messages/read",
  "/api/tasks/:id/messages",
  "/api/tasks/:id/messages/watchers",
  "/api/tasks/:id/move",
  "/api/tasks/:id/queue-seen",
  "/api/tasks/:id/related",
  "/api/tasks/:id",
  "/api/tasks/:id/tags",
  "/api/tasks/bulk-update",
  "/api/tasks/bulk",
  "/api/tasks/queue-unseen",
  "/api/tasks",
  "/api/telemetry/cleanup",
  "/api/telemetry",
  "/api/templates/:id",
  "/api/templates/:id/use",
  "/api/templates",
  "/api/test-socket-emit",
  "/api/tokens/:id",
  "/api/tokens",
  "/api/uploads/direct",
  "/api/uploads/finalize",
  "/api/uploads/presign",
  "/api/user/profile",
  "/api/users"
] as const;

// The root catch-all is the opaque unknown-API handler, not a business route.
// Prefer literal segments, then specific dynamic routes, then scoped catch-alls.
const literalCount = (template: string) => template.split('/').filter(part => part && !part.startsWith(':')).length;
const matchers = API_ROUTE_TEMPLATES.filter(template => template !== '/api/:...path').sort((a,b) =>
  Number(a.includes(':...')) - Number(b.includes(':...')) || literalCount(b) - literalCount(a) || b.length-a.length
).map(template => ({
  template,
  parts: template.split('/').slice(1),
}));
/** Consume transient path only to select a closed label; never retain input. */
export function apiRouteTemplate(pathname: unknown): string | undefined {
  if (typeof pathname !== 'string' || pathname.length > 8192) return;
  const path = pathname.split(/[?#]/, 1)[0];
  if (path !== '/api' && !path.startsWith('/api/')) return;
  const parts = path.replace(/\/$/, '').split('/').slice(1);
  for (const entry of matchers) {
    let valid = true;
    for (let i=0;i<entry.parts.length;i++) {
      const segment = entry.parts[i];
      if (segment.startsWith(':...')) { valid = parts.length > i && parts.slice(i).every(Boolean); break; }
      if (!parts[i] || (!segment.startsWith(':') && segment !== parts[i])) { valid=false; break; }
      if (i === entry.parts.length-1 && parts.length !== entry.parts.length) valid=false;
    }
    if (valid) return entry.template;
  }
  return '/api/:unmatched';
}
