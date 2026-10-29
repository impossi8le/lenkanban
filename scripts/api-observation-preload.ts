// Loaded by Node --require before Next/server.js creates or listens on HTTP.
// Keep instrumentation.register too: it installs framework warnings and Sentry.
import { installNodeApiObservation } from "../src/lib/api-observation.node";

installNodeApiObservation();
