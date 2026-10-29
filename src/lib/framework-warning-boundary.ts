import { apiLogger } from "./logger";

type RejectedActionWarning = {
  event: "framework.server_action.rejected";
  source: "server";
  outcome: "rejected";
  statusCode: 404;
  errorCode: "E788" | "E793";
};
type WarningConsole = Pick<Console, "warn">;
type WarningLogger = { warn: (event: RejectedActionWarning) => void };

// The marker lives on the installed function, so Node HMR/module reloads do not
// stack adapters. Replacing console.warn deliberately permits a fresh install.
const installed = Symbol.for("lenkanban.framework-warning-boundary.v1");

/** Node-only owned logging entrypoint; unrelated console warnings pass through. */
export function installFrameworkWarningBoundary(options: {
  console?: WarningConsole;
  logger?: WarningLogger;
} = {}): void {
  const target = options.console ?? console;
  const sink = options.logger ?? apiLogger;
  const original = target.warn;
  if (Object.getOwnPropertyDescriptor(original, installed)?.value === true) return;

  function warn(this: unknown, ...args: unknown[]): void {
    let code: RejectedActionWarning["errorCode"] | undefined;
    try {
      if (args.length === 1 && args[0] instanceof Error) {
        // Never evaluate an accessor or inspect message/stack/cause/coercion.
        const descriptor = Object.getOwnPropertyDescriptor(args[0], "__NEXT_ERROR_CODE");
        if (descriptor && "value" in descriptor && (descriptor.value === "E788" || descriptor.value === "E793")) {
          code = descriptor.value;
        }
      }
    } catch { /* Uninspectable values retain the original warning behavior. */ }
    if (code) {
      try {
        sink.warn({ event: "framework.server_action.rejected", source: "server", outcome: "rejected", statusCode: 404, errorCode: code });
      } catch { /* Never retry a recognized warning through a raw console sink. */ }
      return;
    }
    Reflect.apply(original, this, args);
  }
  Object.defineProperty(warn, installed, { value: true });
  target.warn = warn;
}
