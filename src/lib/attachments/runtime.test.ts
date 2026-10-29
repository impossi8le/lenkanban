import { describe, expect, it, vi } from "vitest";
import { AttachmentStorageError } from "./storage";
import { createAttachmentStore, readAttachmentRuntimeConfig } from "./runtime";

const enabled = {
  ATTACHMENT_STORAGE: "s3",
  ATTACHMENT_STORAGE_BUCKET: "private-attachments",
  ATTACHMENT_STORAGE_REGION: "eu-central-1",
};

describe("attachment runtime configuration", () => {
  it("uses local storage by default without requiring S3 credentials or the old flag", () => {
    expect(readAttachmentRuntimeConfig({})).toEqual({ enabled: true, storage: "local", directory: "/data/attachments" });
    expect(readAttachmentRuntimeConfig({ ATTACHMENT_STORAGE_ENABLED: "false" }))
      .toEqual({ enabled: true, storage: "local", directory: "/data/attachments" });
    expect(readAttachmentRuntimeConfig({ ATTACHMENT_STORAGE: "local", ATTACHMENT_LOCAL_DIR: "/private/files" }))
      .toEqual({ enabled: true, storage: "local", directory: "/private/files" });
  });

  it.each(["", "S3", "unknown"])("rejects unsupported adapter %j", storage => {
    expect(readAttachmentRuntimeConfig({ ATTACHMENT_STORAGE: storage }))
      .toEqual({ enabled: false, reason: "misconfigured" });
  });

  it.each(["", "relative/files", "../files", "/files\0invalid"])("rejects invalid local directory %j", directory => {
    expect(readAttachmentRuntimeConfig({ ATTACHMENT_LOCAL_DIR: directory }))
      .toEqual({ enabled: false, reason: "misconfigured" });
  });

  it("enables only a valid private bucket and region", () => {
    expect(readAttachmentRuntimeConfig(enabled)).toEqual({
      enabled: true, storage: "s3", bucket: "private-attachments", region: "eu-central-1", endpoint: null,
    });
  });

  it.each([
    ["missing bucket", { ...enabled, ATTACHMENT_STORAGE_BUCKET: "" }],
    ["uppercase bucket", { ...enabled, ATTACHMENT_STORAGE_BUCKET: "Private" }],
    ["bucket traversal", { ...enabled, ATTACHMENT_STORAGE_BUCKET: "private..attachments" }],
    ["missing region", { ...enabled, ATTACHMENT_STORAGE_REGION: "" }],
    ["invalid region", { ...enabled, ATTACHMENT_STORAGE_REGION: "eu central" }],
  ])("fails closed for %s", (_label, env) => {
    expect(readAttachmentRuntimeConfig(env)).toEqual({ enabled: false, reason: "misconfigured" });
  });

  it.each([
    ["plain http", "http://storage.internal"],
    ["credentials", "https://user:pass@storage.internal"],
    ["query", "https://storage.internal/?token=synthetic"],
    ["hash", "https://storage.internal/#x"],
    ["path", "https://storage.internal/prefix"],
    ["not a url", "storage.internal"],
  ])("rejects an unsafe endpoint: %s", (_label, endpoint) => {
    expect(readAttachmentRuntimeConfig({ ...enabled, ATTACHMENT_STORAGE_ENDPOINT: endpoint }))
      .toEqual({ enabled: false, reason: "misconfigured" });
  });

  it("accepts an HTTPS endpoint without userinfo, query or hash", () => {
    expect(readAttachmentRuntimeConfig({ ...enabled, ATTACHMENT_STORAGE_ENDPOINT: "https://storage.internal" }))
      .toEqual({ enabled: true, storage: "s3", bucket: "private-attachments", region: "eu-central-1", endpoint: "https://storage.internal" });
  });
});

describe("attachment store factory", () => {
  it("refuses to build a store for a disabled configuration", () => {
    const factory = vi.fn();
    expect(() => createAttachmentStore({ enabled: false, reason: "disabled" }, factory))
      .toThrow(AttachmentStorageError);
    expect(factory).not.toHaveBeenCalled();
  });

  it("creates one client with a single attempt and the configured bucket", async () => {
    const send = vi.fn(async () => ({}));
    const factory = vi.fn(() => ({ send }));
    const store = createAttachmentStore(
      { enabled: true, storage: "s3", bucket: "private-attachments", region: "eu-central-1", endpoint: null },
      factory,
    );
    expect(factory).toHaveBeenCalledWith({ region: "eu-central-1", maxAttempts: 1 });
    await store.put("task", Uint8Array.from([1]));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uses path style only for an explicit HTTPS endpoint", () => {
    const factory = vi.fn(() => ({ send: vi.fn() }));
    createAttachmentStore(
      { enabled: true, storage: "s3", bucket: "private-attachments", region: "eu-central-1", endpoint: "https://storage.internal" },
      factory,
    );
    expect(factory).toHaveBeenCalledWith({
      region: "eu-central-1", endpoint: "https://storage.internal", forcePathStyle: true, maxAttempts: 1,
    });
  });
});
