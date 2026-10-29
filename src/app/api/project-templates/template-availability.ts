import { z } from "zod";
import { isRetiredProjectTemplate } from "@/lib/project-template-catalog";

/**
 * Template availability is configured explicitly by the template creator.
 * `creator` keeps the template private to its author; `organization` makes it
 * usable by every global administrator. Missing or malformed stored values are
 * treated as `creator` (fail closed) instead of being repaired in place.
 */
export type ProjectTemplateAvailability = "creator" | "organization";

export const projectTemplateAvailabilitySchema = z.enum(["creator", "organization"]);

export function readProjectTemplateAvailability(templateData: unknown): ProjectTemplateAvailability {
  if (templateData === null || typeof templateData !== "object" || Array.isArray(templateData)) return "creator";
  const value = (templateData as { availability?: unknown }).availability;
  return value === "organization" ? "organization" : "creator";
}

/** A global administrator may use a template only when it is explicitly shared. */
export function canUseProjectTemplate(
  template: { id?: string; createdById: string; templateData: unknown },
  actorId: string,
): boolean {
  return !isRetiredProjectTemplate(template) &&
    (template.createdById === actorId || readProjectTemplateAvailability(template.templateData) === "organization");
}
