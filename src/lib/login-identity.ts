import { z } from "zod";

const LOGIN_DOMAIN = "taskboard.lenremontn8n.ru";
const emailSchema = z.string().max(254).email();

/** Resolve local short logins without changing the stored account identity. */
export function normalizeLogin(value: unknown): string {
  if (typeof value !== "string") return "";
  const login = value.trim().toLowerCase();
  if (!login) return "";
  const email = login.includes("@") ? login : `${login}@${LOGIN_DOMAIN}`;
  if (emailSchema.safeParse(email).success) return email;
  // Russian names are local account aliases, never external email addresses.
  const suffix = `@${LOGIN_DOMAIN}`;
  const alias = email.endsWith(suffix) ? email.slice(0, -suffix.length) : "";
  return email.length <= 254 && /[а-яё]/u.test(alias) && /^[а-яёa-z0-9]+$/u.test(alias)
    ? email
    : "";
}

/** Hide only the exact local synthetic suffix; external addresses stay intact. */
export function displayLogin(email: string | null | undefined): string {
  if (!email) return "";
  const suffix = `@${LOGIN_DOMAIN}`;
  return email.toLowerCase().endsWith(suffix) ? email.slice(0, -suffix.length) : email;
}
