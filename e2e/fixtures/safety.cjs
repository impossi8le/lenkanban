// @ts-check

const PRODUCTION_HOSTNAME = "kanban.lenremontn8n.ru";
const MANAGED_SERVER_ORIGIN = "http://127.0.0.1:3555";
const TEST_DATABASE_SUFFIX = "_test";

/**
 * @param {string | undefined} rawUrl
 * @param {string} label
 */
function parseUrl(rawUrl, label) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new Error(`${label} is required`);
  }

  try {
    return new URL(rawUrl);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
}

/**
 * @param {string} hostname
 */
function normalizeHostname(hostname) {
  const withoutIpv6Brackets = hostname.replace(/^\[|\]$/g, "");
  return withoutIpv6Brackets.toLowerCase().replace(/\.+$/g, "");
}

/**
 * @param {string | undefined} rawUrl
 */
function parseSafeBaseUrl(rawUrl) {
  const parsed = parseUrl(rawUrl, "PLAYWRIGHT_BASE_URL");
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PLAYWRIGHT_BASE_URL must use http or https");
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (
    hostname === PRODUCTION_HOSTNAME ||
    hostname.endsWith(`.${PRODUCTION_HOSTNAME}`)
  ) {
    throw new Error("Automated Playwright tests cannot target production");
  }

  return {
    hostname,
    protocol: parsed.protocol,
    url: parsed.href,
  };
}

/**
 * @param {{ hostname: string, protocol: string, url: string }} parsedBaseUrl
 */
function assertLoopbackBaseUrl(parsedBaseUrl) {
  const hostname = normalizeHostname(parsedBaseUrl.hostname);
  const isIpv4Loopback =
    /^127(?:\.\d{1,3}){3}$/.test(hostname) &&
    hostname
      .split(".")
      .slice(1)
      .every((part) => Number(part) >= 0 && Number(part) <= 255);
  const isLoopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    isIpv4Loopback;

  if (!isLoopback) {
    throw new Error(
      "Playwright-managed web server requires a loopback base URL",
    );
  }

  return { ...parsedBaseUrl, hostname };
}

/**
 * @param {{ hostname: string, protocol: string, url: string }} parsedBaseUrl
 */
function assertManagedServerBaseUrl(parsedBaseUrl) {
  const origin = new URL(parsedBaseUrl.url).origin;
  if (origin !== MANAGED_SERVER_ORIGIN) {
    throw new Error(
      `Playwright-managed server requires exact origin ${MANAGED_SERVER_ORIGIN}`,
    );
  }
  return parsedBaseUrl;
}

/**
 * @param {string | undefined} rawUrl
 */
function parseTestDatabaseUrl(rawUrl) {
  const parsed = parseUrl(rawUrl, "E2E_DATABASE_URL");
  if (
    parsed.protocol !== "postgres:" &&
    parsed.protocol !== "postgresql:"
  ) {
    throw new Error(
      "E2E_DATABASE_URL must use the postgres or postgresql protocol",
    );
  }

  const encodedSegment = parsed.pathname.slice(1);
  if (
    !parsed.pathname.startsWith("/") ||
    encodedSegment === "" ||
    encodedSegment.includes("/") ||
    encodedSegment.includes("\\") ||
    /%(?:2f|5c)/i.test(encodedSegment)
  ) {
    throw new Error(
      "E2E_DATABASE_URL must contain exactly one database path segment",
    );
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(encodedSegment);
  } catch {
    throw new Error(
      "E2E_DATABASE_URL database name must be valid percent-encoding",
    );
  }

  if (
    databaseName === "" ||
    databaseName.includes("/") ||
    databaseName.includes("\\") ||
    /%(?:2f|5c)/i.test(databaseName)
  ) {
    throw new Error(
      "E2E_DATABASE_URL must contain exactly one decoded database segment",
    );
  }
  if (!databaseName.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(
      "E2E_DATABASE_URL database name must end exactly in _test",
    );
  }

  return {
    databaseName,
    url: parsed.href,
  };
}

module.exports = {
  assertManagedServerBaseUrl,
  assertLoopbackBaseUrl,
  normalizeHostname,
  parseSafeBaseUrl,
  parseTestDatabaseUrl,
};
