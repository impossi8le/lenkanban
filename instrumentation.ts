export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installNodeApiObservation } = await import("./src/lib/api-observation.node");
    installNodeApiObservation();
    const { installFrameworkWarningBoundary } = await import("./src/lib/framework-warning-boundary");
    installFrameworkWarningBoundary();
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.server.config");
  }
}
