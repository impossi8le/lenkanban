import pino from "pino";
import { sanitizeTelemetryContext } from "./telemetry-sanitize";
const isDevelopment = process.env.NODE_ENV === "development";
// Exact, static legacy messages only. Unknown text never becomes a log field.
const legacyEvents = new Map([
  ["Error parsing session response", "socket.session.parse_failed"],
  ["Error calling session API", "socket.session.request_failed"],
  ["Session API timeout", "socket.session.timeout"],
  ["Authentication successful", "socket.auth.succeeded"],
  ["Authentication failed - no authed data", "socket.auth.rejected"],
  ["Auth error", "socket.auth.failed"],
  ["New connection", "socket.connection.created"],
  ["No userId - disconnecting", "socket.connection.rejected"],
  ["Registering auth middleware", "socket.auth.registered"],
  ["Access denied to project", "socket.project.rejected"],
  ["Task not found", "socket.task.not_found"],
  ["Failed to log activity", "activity.write.failed"],
]);
const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? "debug" : "info"),
  ...(isDevelopment ? {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname"
      }
    }
  } : {}),
  base: sanitizeTelemetryContext({
    env: process.env.NODE_ENV,
    revision: process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT
  }),
  formatters: {
    bindings: sanitizeTelemetryContext
  },
  hooks: {
    logMethod(args, method) {
      try {
        // Child/direct calls share this boundary. Free-form messages may contain input.
        const context = typeof args[0] === "object" ? sanitizeTelemetryContext(args[0]) : {};
        const text = typeof args[0] === "string" ? args[0] : args[1];
        if (!context.event) {
          context.event = typeof text === "string" ? legacyEvents.get(text) || "legacy.unclassified" : "legacy.unclassified";
        }
        method.call(this, context, "Application event");
      }
      catch { /* All boundary/sink failures are non-fatal; no raw fallback. */
      }
    }
  }
});
const rawChild = logger.child;
function protectChildren(instance: typeof logger): typeof logger {
  instance.child = function <Levels extends string = never>(this: typeof logger, bindings: pino.Bindings, options?: pino.ChildLoggerOptions<Levels>): pino.Logger<Levels> {
    const child = rawChild.call(this, sanitizeTelemetryContext(bindings), {
      ...options,
      formatters: {
        ...options?.formatters,
        bindings: sanitizeTelemetryContext
      }
    });
    // Pino's generic custom-level signature is preserved by the original factory.
    return protectChildren(child as unknown as typeof logger) as unknown as pino.Logger<Levels>;
  };
  return instance;
}
protectChildren(logger);
export const apiLogger = logger.child({
  module: "api"
});
export const authLogger = logger.child({
  module: "auth"
});
export const socketLogger = logger.child({
  module: "socket"
});
export const dbLogger = logger.child({
  module: "database"
});
export const emailLogger = logger.child({
  module: "email"
});
export const automationLogger = logger.child({
  module: "automation"
});
// Existing signatures stay valid; route templates belong in explicit context.
export function logApiRequest(method: string, _path: string, userId?: string, duration?: number, statusCode?: number) {
  apiLogger.info({
    event: "api.request.completed",
    method,
    userId,
    durationMs: duration,
    statusCode
  });
}
export function logApiError(method: string, _path: string, error: Error, userId?: string, statusCode?: number) {
  apiLogger.error({
    event: "api.request.failed",
    method,
    userId,
    statusCode,
    err: error
  });
}
export function logAuthEvent(event: "login" | "logout" | "register" | "verify" | "reset_password", userId?: string, _email?: string, success = true, error?: Error) {
  try {
    authLogger[success ? "info" : "error"]({
      event: `auth.${event}`,
      userId,
      success,
      ...(error ? {
        err: error
      } : {})
    });
  }
  catch { /* No raw fallback when a sink fails. */
  }
}
export function logSocketEvent(event: string, socketId: string, userId?: string, _data?: Record<string, unknown>) {
  void _data;
  socketLogger.debug({
    event,
    socketId,
    userId
  });
}
export function logDbQuery(operation: string, model: string, duration?: number, error?: Error) {
  dbLogger[error ? "error" : "debug"]({
    event: "database.operation",
    operation,
    model,
    durationMs: duration,
    ...(error ? {
      err: error
    } : {})
  });
}
export function logEmail(_to: string, _subject: string, success: boolean, error?: Error) {
  try {
    emailLogger[success ? "info" : "error"]({
      event: "email.result",
      success,
      ...(error ? {
        err: error
      } : {})
    });
  }
  catch { /* No raw console fallback. */
  }
}
export function logAutomation(ruleId: string, _ruleName: string, taskId: string, success: boolean, error?: Error) {
  automationLogger[success ? "info" : "error"]({
    event: "automation.result",
    ruleId,
    taskId,
    success,
    ...(error ? {
      err: error
    } : {})
  });
}
export default logger;
