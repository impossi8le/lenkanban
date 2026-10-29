import type { Prisma } from "@prisma/client";

export const TASK_SEARCH_QUERY_LIMIT = 200;
/** A request search stays useful with a few words; the bounded list keeps the SQL predicate small. */
export const TASK_SEARCH_TOKEN_LIMIT = 8;
/** Identifier substrings need at least four code points; shorter terms match unrelated ids by accident. */
export const TASK_SEARCH_IDENTIFIER_MIN_LENGTH = 4;

/**
 * One shared, ordered field list for every request search. Access is never
 * decided here: the caller composes this predicate with the common read gate.
 * New searchable model fields belong in this list, not in an ad-hoc OR branch.
 */
export const TASK_SEARCH_FIELDS = [
  "title",
  "description",
  "requestAuthor",
  "requestExecutor",
  "legacyCreator",
  "legacyAssignees",
  "identifier",
  "project",
  "tags",
] as const;
export type TaskSearchField = (typeof TASK_SEARCH_FIELDS)[number];

type SearchBranch = (term: string) => Prisma.TaskWhereInput;

const SEARCH_BRANCHES: Record<TaskSearchField, SearchBranch> = {
  title: term => ({ title: { contains: term, mode: "insensitive" } }),
  description: term => ({ description: { contains: term, mode: "insensitive" } }),
  requestAuthor: term => ({
    request: { is: { contractVersion: 1, author: { is: { name: { contains: term, mode: "insensitive" } } } } },
  }),
  requestExecutor: term => ({
    request: { is: { contractVersion: 1, executor: { is: { name: { contains: term, mode: "insensitive" } } } } },
  }),
  // Canonical requests keep their actual people only; stale legacy rows must
  // not create extra matches for a migrated request.
  legacyCreator: term => ({
    request: { is: null },
    createdBy: { is: { name: { contains: term, mode: "insensitive" } } },
  }),
  legacyAssignees: term => ({
    request: { is: null },
    assignees: { some: { user: { is: { name: { contains: term, mode: "insensitive" } } } } },
  }),
  identifier: term => ({ id: { contains: term, mode: "insensitive" } }),
  project: term => ({ project: { is: { name: { contains: term, mode: "insensitive" } } } }),
  tags: term => ({ tags: { some: { tag: { is: { name: { contains: term, mode: "insensitive" } } } } } }),
};

export function normalizeTaskSearch(value: string | null | undefined): string {
  return (value ?? "").trim().slice(0, TASK_SEARCH_QUERY_LIMIT);
}

/**
 * Split a query into independent words. Separators and edge punctuation are
 * ignored, duplicates are collapsed and the result is bounded. Searching every
 * word instead of the raw phrase makes "пропуск Анна" and "Анна пропуск"
 * equivalent without changing read access.
 */
export function tokenizeTaskSearch(value: string | null | undefined): string[] {
  const normalized = normalizeTaskSearch(value);
  if (!normalized) return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0];
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(term);
    if (tokens.length >= TASK_SEARCH_TOKEN_LIMIT) break;
  }
  return tokens;
}

function branches(term: string): Prisma.TaskWhereInput[] {
  // Shorter terms still search every public content field; only the identifier
  // substring branch is omitted so it cannot match unrelated id characters.
  return TASK_SEARCH_FIELDS.filter(
    field => field !== "identifier" || Array.from(term).length >= TASK_SEARCH_IDENTIFIER_MIN_LENGTH,
  ).map(field => SEARCH_BRANCHES[field](term));
}

/**
 * Search request content and its actual people; read access is composed by the
 * caller. Every word must match at least one shared field, so word order does
 * not matter and hidden comments/attachments are never indexed.
 */
export function taskSearchPredicate(search: string): Prisma.TaskWhereInput {
  const tokens = tokenizeTaskSearch(search);
  if (tokens.length === 0) return { OR: [] };
  // Keep the long-standing single-term shape; only multi-word queries need a
  // per-word AND.
  if (tokens.length === 1) return { OR: branches(tokens[0]) };
  return { AND: tokens.map(term => ({ OR: branches(term) })) };
}
