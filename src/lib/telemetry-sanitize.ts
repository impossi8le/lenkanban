/** Shared browser/server boundary: arbitrary values never pass through to a sink. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const label = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/;
const idKeys = new Set(["userId", "actorId", "projectId", "taskId", "ruleId", "socketId", "recurringTaskId"]);
const uuidKeys = new Set(["requestId", "actionId", "operationId", "parentOperationId", "errorId"]);
const labelKeys = new Set(["event", "source", "module", "errorCode", "operation", "model", "outcome", "env", "template"]);
const numberKeys = new Set(["schemaVersion", "statusCode", "duration", "durationMs", "count", "attempt", "timestamp", "seq"]);
const allowedKeys = [...idKeys, ...uuidKeys, ...labelKeys, ...numberKeys, "durationKind", "handlerDurationMs", "success", "method", "route", "revision", "err"];
function safeFrame(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return;
  }
  const frame = value as {
    filename?: unknown;
    lineno?: unknown;
    colno?: unknown;
    in_app?: unknown;
  };
  if (frame.in_app !== true) {
    return;
  }
  const result: Record<string, unknown> = {
    in_app: true
  };
  if (typeof frame.filename === "string") {
    const basename = frame.filename.split(/[?#]/, 1)[0].split(/[\\/]/).at(-1);
    if (basename && /^[a-zA-Z0-9_.-]{1,100}\.(?:[cm]?js|jsx|ts|tsx)$/.test(basename)) {
      result.filename = basename;
    }
  }
  for (const key of ["lineno", "colno"] as const) {
    if (typeof frame[key] === "number" && Number.isInteger(frame[key]) && frame[key] >= 0) {
      result[key] = frame[key];
    }
  }
  return result;
}
export function validCorrelationId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
const errorTypes = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError"]);
export function safeError(error: unknown): {
  type: string;
  message: string;
  frames?: Record<string, unknown>[];
} {
  try {
    // Retain built-in type and source basenames/coordinates, never raw message/cause.
    if (!(error instanceof Error)) {
      return {
        type: "UnknownError",
        message: "Application error"
      };
    }
    const name = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(error), "name")?.value;
    const type = typeof name === "string" && errorTypes.has(name) ? name : "Error";
    const stack = error.stack;
    const frames: Record<string, unknown>[] = [];
    const rawName = error.name;
    const rawMessage = error.message;
    const prefix = typeof rawName === "string" && typeof rawMessage === "string"
      ? rawMessage ? rawName + ": " + rawMessage : rawName
      : undefined;
    // A multiline message can impersonate "at file.ts:line:col". Remove the
    // complete exact header first, not merely the first stack line.
    if (typeof stack === "string" && prefix !== undefined && stack.startsWith(prefix)) {
      for (const line of stack.slice(prefix.length, prefix.length + 20000).split("\n").slice(0, 40)) {
        if (!/^\s+at /.test(line)) {
          continue;
        }
        const match = line.match(/(?:^|[\\/])([a-zA-Z0-9_.-]{1,100}\.(?:[cm]?js|jsx|ts|tsx)):(\d+):(\d+)\)?$/);
        if (match) {
          frames.push({
            filename: match[1],
            lineno: Number(match[2]),
            colno: Number(match[3])
          });
        }
      }
    }
    return {
      type,
      message: "Application error",
      ...(frames.length ? {
        frames
      } : {})
    };
  }
  catch {
    return {
      type: "UnknownError",
      message: "Application error"
    };
  }
}
export function sanitizeTelemetryContext(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const result: Record<string, unknown> = {};
  // No getters, recursion, prototype data or arbitrary payload serialization.
  for (const key of allowedKeys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    }
    catch {
      return {};
    }
    if (!descriptor) {
      continue;
    }
    if (!("value" in descriptor)) {
      continue;
    }
    const item: unknown = descriptor.value;
    if (uuidKeys.has(key) && validCorrelationId(item)) {
      result[key] = item;
    }
    else if (idKeys.has(key) && typeof item === "string" && identifier.test(item)) {
      result[key] = item;
    }
    else if (labelKeys.has(key) && typeof item === "string" && label.test(item)) {
      result[key] = item;
    }
    else if (numberKeys.has(key) && typeof item === "number" && Number.isFinite(item) && item >= 0) {
      result[key] = item;
    }
    else if (key === "success" && typeof item === "boolean") {
      result[key] = item;
    }
    else if (key === "durationKind" && (item === "http" || item === "handler")) {
      result[key] = item;
    }
    else if (key === "handlerDurationMs" && typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 86_400_000) {
      result[key] = item;
    }
    else if (key === "method" && typeof item === "string" && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|OTHER)$/.test(item)) {
      result[key] = item;
    }
    else if (key === "route" && typeof item === "string" && item.length <= 200 && /^\/[a-zA-Z0-9_/:.\[\]-]*$/.test(item)) {
      result[key] = item;
    }
    else if (key === "revision" && typeof item === "string" && /^[a-f0-9]{7,64}$/i.test(item)) {
      result[key] = item;
    }
    else if (key === "err") {
      result.err = safeError(item);
    }
  }
  return result;
}
/** Minimal SDK envelope. Unknown SDK extras are never forwarded. */
export function sanitizeSentryEvent<T extends object>(event: T): T {
  try {
    const input = event as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of ["event_id", "timestamp", "platform", "level", "environment", "release", "type"]) {
      const value = input[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        result[key] = value;
      }
      else if (typeof value === "string" && /^[a-zA-Z0-9_.:@/-]{1,128}$/.test(value)) {
        result[key] = value;
      }
    }
    if (input.message !== undefined) {
      result.message = "Application error";
    }
    if (input.exception) {
      const values = (input.exception as {
        values?: {
          stacktrace?: {
            frames?: unknown[];
          };
        }[];
      }).values;
      const frames = Array.isArray(values) ? values.at(-1)?.stacktrace?.frames : undefined;
      const safeFrames = Array.isArray(frames) ? frames.slice(-40).map(safeFrame).filter(Boolean) : [];
      const type = Array.isArray(values) ? (values.at(-1) as {
        type?: unknown;
      } | undefined)?.type : undefined;
      result.exception = {
        values: [{
          type: typeof type === "string" && errorTypes.has(type) ? type : "Error",
          value: "Application error",
          ...(safeFrames.length ? {
            stacktrace: {
              frames: safeFrames
            }
          } : {})
        }]
      };
    }
    if (input.tags) {
      result.tags = sanitizeTelemetryContext(input.tags);
    }
    if (input.extra) {
      result.extra = sanitizeTelemetryContext(input.extra);
    }
    if (input.user && typeof input.user === "object") {
      const id = (input.user as {
        id?: unknown;
      }).id;
      if (typeof id === "string" && identifier.test(id)) {
        result.user = {
          id
        };
      }
    }
    if (Array.isArray(input.breadcrumbs)) {
      result.breadcrumbs = input.breadcrumbs.slice(-50).map((breadcrumb: unknown) => {
        const data = breadcrumb && typeof breadcrumb === "object" ? (breadcrumb as {
          data?: unknown;
        }).data : undefined;
        const timing = sanitizeTelemetryContext(breadcrumb);
        return {
          category: "application",
          ...(timing.timestamp !== undefined ? {
            timestamp: timing.timestamp
          } : {}),
          data: {
            ...sanitizeTelemetryContext(data),
            ...(timing.seq !== undefined ? {
              seq: timing.seq
            } : {})
          }
        };
      });
    }
    // URL/body/headers, contexts, transaction names and stack source may embed input.
    // Correlation remains in explicitly allowed tags and extra.
    return result as T;
  }
  catch {
    return {} as T;
  }
}
