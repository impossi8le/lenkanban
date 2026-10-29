import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type SMTPTransport from "app-nodemailer/lib/smtp-transport";

const mocks = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn(), log: vi.fn() }));
vi.mock("app-nodemailer", () => ({ default: { createTransport: mocks.create } }));
vi.mock("./logger", () => ({ logEmail: mocks.log }));

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  mocks.create.mockReturnValue({ sendMail: mocks.send }); mocks.send.mockResolvedValue({});
  vi.stubEnv("SMTP_HOST", "127.0.0.1"); vi.stubEnv("SMTP_PORT", "9");
  vi.stubEnv("SMTP_SECURE", "false"); vi.stubEnv("SMTP_USER", ""); vi.stubEnv("SMTP_PASS", "");
  vi.stubEnv("APP_URL", "https://synthetic.example.invalid");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("verification email transport security", () => {
  it.each([
    { label: "implicit TLS465 with basic credentials", secure: "true", port: "465", authenticated: true, requireTLS: undefined },
    { label: "required STARTTLS587 with basic credentials", secure: "false", port: "587", authenticated: true, requireTLS: true },
    { label: "explicit local unauthenticated sink", secure: "false", port: "9", authenticated: false, requireTLS: undefined },
  ])("preserves certificate validation for $label", async ({ secure, port, authenticated, requireTLS }) => {
    vi.stubEnv("SMTP_SECURE", secure); vi.stubEnv("SMTP_PORT", port);
    if (authenticated) { vi.stubEnv("SMTP_USER", "synthetic-user"); vi.stubEnv("SMTP_PASS", "synthetic-password"); }
    const email = await import("./email");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    await email.sendVerificationEmail("recipient@example.invalid", "synthetic-token", "Synthetic name");
    expect(mocks.create).toHaveBeenCalledOnce();
    const config = mocks.create.mock.calls[0][0] as SMTPTransport.Options;
    expect(config.host).toBe("127.0.0.1"); expect(config.port).toBe(Number(port));
    expect(config.secure).toBe(secure === "true");
    expect(config.tls?.rejectUnauthorized).not.toBe(false);
    expect(config.requireTLS).toBe(requireTLS);
    expect(config.ignoreTLS).not.toBe(true);
    expect(config.auth).toEqual(authenticated ? { user: "synthetic-user", pass: "synthetic-password" } : undefined);
    expect(config.logger).not.toBe(true); expect(config.debug).not.toBe(true);
    expect(mocks.send).toHaveBeenCalledOnce();
    stdout.mockRestore();
  });
});

describe("verification email diagnostics", () => {
  it.each([true, false])("emits safe result only for success=%s, preserving delivery failure", async success => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "synthetic-nested-SMTP-secret";
    const failure = Object.assign(new Error(secret), {
      cause: { response: { recipient: "recipient@example.invalid", token: secret, credentials: { password: secret } } },
      response: `${secret} https://synthetic.example.invalid/verify-email?token=${secret}`,
    });
    if (!success) mocks.send.mockRejectedValue(failure);
    const { sendVerificationEmail } = await import("./email");
    const sending = sendVerificationEmail("recipient@example.invalid", secret, "Synthetic private name");
    if (success) await sending; else await expect(sending).rejects.toBe(failure);
    expect(mocks.log).toHaveBeenCalledExactlyOnceWith("", "", success);
    expect(stdout).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.log.mock.calls)).not.toMatch(/synthetic|recipient|private|credentials|verify-email/i);
  });
});
