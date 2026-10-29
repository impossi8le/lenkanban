import { S3Client } from "@aws-sdk/client-s3";
import { isAbsolute } from "node:path";
import { createLocalAttachmentStore } from "./local-storage";
import { AttachmentStorageError, createPrivateAttachmentStore, type ListableAttachmentStore } from "./storage";

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{2,32}$/;

export type AttachmentRuntimeConfig =
  | { enabled: false; reason: "disabled" | "misconfigured" }
  | { enabled: true; storage: "local"; directory: string }
  | { enabled: true; storage: "s3"; bucket: string; region: string; endpoint: string | null };

/** Server-only endpoint: HTTPS, no userinfo, query, hash or path traversal. */
function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username && !url.password && !url.search && !url.hash
      && (url.pathname === "/" || url.pathname === "");
  } catch {
    return false;
  }
}

/**
 * Local storage is the MVP default. Explicit S3 selection requires valid
 * bucket/region settings; invalid selections never fall back to another store.
 */
export function readAttachmentRuntimeConfig(
  env: Record<string, string | undefined>,
): AttachmentRuntimeConfig {
  const storage = env.ATTACHMENT_STORAGE ?? "local";
  if (storage === "local") {
    const directory = env.ATTACHMENT_LOCAL_DIR ?? "/data/attachments";
    if (!directory || !isAbsolute(directory) || directory.includes("\0")) {
      return { enabled: false, reason: "misconfigured" };
    }
    return { enabled: true, storage, directory };
  }
  if (storage !== "s3") return { enabled: false, reason: "misconfigured" };
  const bucket = (env.ATTACHMENT_STORAGE_BUCKET ?? "").trim();
  const region = (env.ATTACHMENT_STORAGE_REGION ?? "").trim();
  const endpoint = (env.ATTACHMENT_STORAGE_ENDPOINT ?? "").trim() || null;
  if (!BUCKET.test(bucket) || bucket.includes("..") || !REGION.test(region)
    || (endpoint !== null && !validEndpoint(endpoint))) {
    return { enabled: false, reason: "misconfigured" };
  }
  return { enabled: true, storage, bucket, region, endpoint };
}

export type AttachmentClientFactory = (options: {
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  maxAttempts: number;
}) => Pick<S3Client, "send">;

function defaultClientFactory(options: {
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  maxAttempts: number;
}): Pick<S3Client, "send"> {
  return new S3Client(options);
}

/**
 * Creates the configured private store. Local initialization failures are safe errors.
 * Credentials, bucket policy and prefix IAM are deployment responsibilities;
 * this function never reads or changes them.
 */
export function createAttachmentStore(
  config: AttachmentRuntimeConfig,
  factory: AttachmentClientFactory = defaultClientFactory,
): ListableAttachmentStore {
  if (!config.enabled) throw new AttachmentStorageError("UNAVAILABLE");
  if (config.storage === "local") return createLocalAttachmentStore(config.directory);
  const client = factory({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
    // No hidden SDK retries: a repeated transport attempt is a separate decision.
    maxAttempts: 1,
  });
  return createPrivateAttachmentStore(client, config.bucket);
}
