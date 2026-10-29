import { apiError } from "@/lib/api-response";

// Comments module was replaced by real-time Task Chat.
// Keep this route returning 410 so old clients don't silently break.

export async function GET() {
  return apiError("COMMENTS_DEPRECATED", "Use /api/tasks/:id/messages", undefined, 410);
}

export async function POST() {
  return apiError("COMMENTS_DEPRECATED", "Use /api/tasks/:id/messages", undefined, 410);
}
