import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";

// Importing the actual timeline must never evaluate server persistence/logging.
vi.mock("@/lib/activity-logger", () => { throw new Error("SERVER_ACTIVITY_MODULE_REACHED_CLIENT"); });
vi.mock("@/lib/prisma", () => { throw new Error("PRISMA_REACHED_CLIENT_TIMELINE"); });
vi.mock("@/lib/logger", () => { throw new Error("LOGGER_REACHED_CLIENT_TIMELINE"); });
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "actor" } } }) }));
vi.mock("@/lib/api", () => ({ apiFetch: async () => [{ id: "event", action: "created", oldValue: null, newValue: null, createdAt: "2026-10-28T10:00:00Z", user: { id: "actor", name: "Анна", email: "synthetic@example.invalid", avatarUrl: null } }] }));
import { ActivityTimeline } from "./ActivityTimeline";

let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); });
it("renders real localized history while server-only imports are forbidden", async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ActivityTimeline taskId="task" /></QueryClientProvider>);
  expect(await screen.findByText("Анна создал задачу")).toBeInTheDocument();
});
