/**
 * Structural validator for the process board template descriptions in this
 * directory. It is a pure function over already-parsed JSON: no database, no
 * filesystem, no logging and no side effects.
 *
 * The templates are declarations for future boards, not an active feature.
 * Nothing here writes to Prisma, creates columns or changes permissions.
 */

export const RESERVED_WORKFLOW_KEYS = ["TODO", "IN_PROGRESS", "REVIEW", "DONE"] as const;

export type ReservedWorkflowKey = (typeof RESERVED_WORKFLOW_KEYS)[number];

/** `active`/`enabled` are deliberately absent: a template file cannot claim to be live. */
export const ALLOWED_ACTIVATIONS = ["declared-not-active", "pilot-candidate"] as const;

export type TemplateActivation = (typeof ALLOWED_ACTIVATIONS)[number];

export const FORBIDDEN_TRANSITION_FIELDS = [
  "targetBoard",
  "toBoard",
  "boardKey",
  "targetProjectId",
] as const;

export interface ValidationIssue {
  /** Stable machine-readable code; safe to assert on in tests. */
  code: string;
  /** Location inside the template, e.g. `columns[2].key`. */
  path: string;
  /** Human-readable explanation. Never contains template text beyond the path. */
  message: string;
}

export interface TemplateSummary {
  key: string;
  name: string;
  activation: TemplateActivation;
  columnKeys: string[];
  extraStateKeys: string[];
  finalColumnKey: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  templates: TemplateSummary[];
}

export interface TemplateSource {
  /** File name or label used in issue paths. */
  source: string;
  data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface TemplateDraft {
  key: string | null;
  activation: TemplateActivation | null;
  columnKeys: string[];
  extraStateKeys: string[];
  finalColumnKey: string | null;
  issues: ValidationIssue[];
}

function issue(code: string, path: string, message: string): ValidationIssue {
  return { code, path, message };
}

function validateColumns(
  template: Record<string, unknown>,
  base: string,
  draft: TemplateDraft,
): void {
  const rawColumns = template.columns;
  if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
    draft.issues.push(issue("columns.missing", `${base}columns`, "Template must declare at least one column."));
    return;
  }
  if (rawColumns.length < 2) {
    draft.issues.push(issue("columns.too_few", `${base}columns`, "A board needs at least two columns."));
  }

  const seenKeys = new Set<string>();
  const seenNames = new Set<string>();
  const seenPositions = new Set<number>();
  const seenWorkflowKeys = new Set<string>();
  let finalCount = 0;
  let finalIndex = -1;
  let previousPosition = -1;

  rawColumns.forEach((raw, index) => {
    const path = `${base}columns[${index}]`;
    if (!isRecord(raw)) {
      draft.issues.push(issue("column.not_object", path, "Column must be an object."));
      return;
    }

    if (!isNonEmptyString(raw.key)) {
      draft.issues.push(issue("column.key.empty", `${path}.key`, "Column key must be a non-empty string."));
    } else if (!KEBAB_CASE.test(raw.key)) {
      draft.issues.push(issue("column.key.format", `${path}.key`, "Column key must be kebab-case."));
    } else if (seenKeys.has(raw.key)) {
      draft.issues.push(issue("column.key.duplicate", `${path}.key`, "Column keys must be unique within a template."));
    } else {
      seenKeys.add(raw.key);
      draft.columnKeys.push(raw.key);
    }

    if (!isNonEmptyString(raw.name)) {
      draft.issues.push(issue("column.name.empty", `${path}.name`, "Column name must not be empty."));
    } else if (seenNames.has(raw.name.trim())) {
      draft.issues.push(issue("column.name.duplicate", `${path}.name`, "Column names must be unique within a template."));
    } else {
      seenNames.add(raw.name.trim());
    }

    if (!Number.isInteger(raw.position)) {
      draft.issues.push(issue("column.position.invalid", `${path}.position`, "Column position must be an integer."));
    } else {
      const position = raw.position as number;
      if (position < 0) {
        draft.issues.push(issue("column.position.negative", `${path}.position`, "Column position must not be negative."));
      }
      if (seenPositions.has(position)) {
        draft.issues.push(issue("column.position.duplicate", `${path}.position`, "Column positions must be unique."));
      } else {
        seenPositions.add(position);
      }
      if (position !== index) {
        draft.issues.push(issue("column.position.order", `${path}.position`, "Column positions must match array order starting at 0."));
      }
      if (position <= previousPosition) {
        draft.issues.push(issue("column.position.ascending", `${path}.position`, "Column positions must strictly increase."));
      }
      previousPosition = Math.max(previousPosition, position);
    }

    if (typeof raw.final !== "boolean") {
      draft.issues.push(issue("column.final.invalid", `${path}.final`, "Column must declare a boolean `final`."));
    } else if (raw.final) {
      finalCount += 1;
      finalIndex = index;
      if (isNonEmptyString(raw.key)) draft.finalColumnKey = raw.key;
    }

    if (raw.workflowKey === undefined || raw.workflowKey === null) {
      // Non-reserved columns receive a generated workflow key at board creation.
    } else if (!isNonEmptyString(raw.workflowKey)) {
      draft.issues.push(issue("column.workflow_key.invalid", `${path}.workflowKey`, "workflowKey must be a string or null."));
    } else if (!(RESERVED_WORKFLOW_KEYS as readonly string[]).includes(raw.workflowKey)) {
      draft.issues.push(issue("column.workflow_key.reserved", `${path}.workflowKey`, "Only TODO, IN_PROGRESS, REVIEW and DONE are stable workflow keys."));
    } else if (seenWorkflowKeys.has(raw.workflowKey)) {
      draft.issues.push(issue("column.workflow_key.duplicate", `${path}.workflowKey`, "Reserved workflow keys must be unique."));
    } else {
      seenWorkflowKeys.add(raw.workflowKey);
    }
  });

  if (finalCount === 0) {
    draft.issues.push(issue("columns.final.missing", `${base}columns`, "Exactly one column must be marked final."));
  } else if (finalCount > 1) {
    draft.issues.push(issue("columns.final.multiple", `${base}columns`, "Exactly one column may be marked final."));
  } else if (finalIndex !== rawColumns.length - 1) {
    draft.issues.push(issue("columns.final.position", `${base}columns[${finalIndex}]`, "The final column must be the last one."));
  }
}

function validateExtraStates(
  template: Record<string, unknown>,
  base: string,
  draft: TemplateDraft,
): void {
  const rawStates = template.extraStates;
  if (rawStates === undefined) return;
  if (!Array.isArray(rawStates)) {
    draft.issues.push(issue("extra_states.invalid", `${base}extraStates`, "extraStates must be an array."));
    return;
  }

  const seen = new Set<string>();
  rawStates.forEach((raw, index) => {
    const path = `${base}extraStates[${index}]`;
    if (!isRecord(raw)) {
      draft.issues.push(issue("extra_state.not_object", path, "Extra state must be an object."));
      return;
    }
    if (!isNonEmptyString(raw.key)) {
      draft.issues.push(issue("extra_state.key.empty", `${path}.key`, "Extra state key must be a non-empty string."));
    } else if (seen.has(raw.key)) {
      draft.issues.push(issue("extra_state.key.duplicate", `${path}.key`, "Extra state keys must be unique."));
    } else if (draft.columnKeys.includes(raw.key)) {
      draft.issues.push(issue("extra_state.key.collision", `${path}.key`, "Extra state key must not collide with a column key."));
    } else {
      seen.add(raw.key);
      draft.extraStateKeys.push(raw.key);
    }
    if (!isNonEmptyString(raw.name)) {
      draft.issues.push(issue("extra_state.name.empty", `${path}.name`, "Extra state name must not be empty."));
    }
    if (raw.final === true) {
      draft.issues.push(issue("extra_state.final", `${path}.final`, "Only a board column may be final."));
    }
  });
}

function validateTransitions(
  template: Record<string, unknown>,
  base: string,
  draft: TemplateDraft,
): void {
  const rawTransitions = template.transitions;
  if (!Array.isArray(rawTransitions) || rawTransitions.length === 0) {
    draft.issues.push(issue("transitions.missing", `${base}transitions`, "Template must declare allowed transitions."));
    return;
  }

  const known = new Set<string>([...draft.columnKeys, ...draft.extraStateKeys]);
  const seenPairs = new Set<string>();

  rawTransitions.forEach((raw, index) => {
    const path = `${base}transitions[${index}]`;
    if (!isRecord(raw)) {
      draft.issues.push(issue("transition.not_object", path, "Transition must be an object."));
      return;
    }

    for (const field of FORBIDDEN_TRANSITION_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(raw, field)) {
        draft.issues.push(
          issue(
            "transition.cross_board_field",
            `${path}.${field}`,
            "Cross-board transfer is forbidden; remove board/project targeting fields.",
          ),
        );
      }
    }

    for (const end of ["from", "to"] as const) {
      const value = raw[end];
      if (!isNonEmptyString(value)) {
        draft.issues.push(issue(`transition.${end}.empty`, `${path}.${end}`, "Transition endpoint must be a non-empty string."));
        continue;
      }
      if (value.includes(":") || value.includes("/")) {
        draft.issues.push(
          issue(
            "transition.cross_board_reference",
            `${path}.${end}`,
            "Transition endpoints must be plain column keys; qualified board references are forbidden.",
          ),
        );
        continue;
      }
      if (!known.has(value)) {
        draft.issues.push(issue(`transition.${end}.unknown`, `${path}.${end}`, "Transition references an unknown column or state."));
      }
    }

    if (isNonEmptyString(raw.from) && raw.from === raw.to) {
      draft.issues.push(issue("transition.self", path, "A transition must not point to the same state."));
    }

    if (isNonEmptyString(raw.from) && isNonEmptyString(raw.to)) {
      const pair = `${raw.from}->${raw.to}`;
      if (seenPairs.has(pair)) {
        draft.issues.push(issue("transition.duplicate", path, "Duplicate transition."));
      } else {
        seenPairs.add(pair);
      }
    }

    if (!isNonEmptyString(raw.action)) {
      draft.issues.push(issue("transition.action.empty", `${path}.action`, "Transition action must not be empty."));
    }
    if (!isNonEmptyString(raw.actor)) {
      draft.issues.push(issue("transition.actor.empty", `${path}.actor`, "Transition actor must not be empty."));
    }
  });
}

function validateVisibility(
  template: Record<string, unknown>,
  base: string,
  draft: TemplateDraft,
): void {
  const visibility = template.visibility;
  if (!isRecord(visibility)) {
    draft.issues.push(issue("visibility.missing", `${base}visibility`, "Visibility requirements must be declared."));
    return;
  }
  if (visibility.enforced !== false || visibility.declaredOnly !== true) {
    draft.issues.push(
      issue(
        "visibility.claims_enforcement",
        `${base}visibility`,
        "Templates only declare visibility requirements; they must not claim enforcement.",
      ),
    );
  }
  const rules = visibility.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    draft.issues.push(issue("visibility.rules.missing", `${base}visibility.rules`, "At least one visibility rule is required."));
    return;
  }
  rules.forEach((raw, index) => {
    const path = `${base}visibility.rules[${index}]`;
    if (!isRecord(raw)) {
      draft.issues.push(issue("visibility.rule.not_object", path, "Visibility rule must be an object."));
      return;
    }
    if (!isNonEmptyString(raw.subject)) {
      draft.issues.push(issue("visibility.rule.subject.empty", `${path}.subject`, "Visibility rule subject must not be empty."));
    }
    const canSee = raw.canSee;
    if (!Array.isArray(canSee) || canSee.length === 0 || !canSee.every(isNonEmptyString)) {
      draft.issues.push(issue("visibility.rule.can_see.empty", `${path}.canSee`, "Visibility rule must list what the subject can see."));
    }
  });
}

function validateSla(
  template: Record<string, unknown>,
  base: string,
  draft: TemplateDraft,
): void {
  const sla = template.sla;
  if (!isRecord(sla)) {
    draft.issues.push(issue("sla.missing", `${base}sla`, "SLA hints must be declared."));
    return;
  }
  if (sla.clock !== "work_started") {
    draft.issues.push(issue("sla.clock.invalid", `${base}sla.clock`, "The SLA clock starts when work starts."));
  }
  if (sla.pausesOnClarification !== true) {
    draft.issues.push(issue("sla.pause.missing", `${base}sla.pausesOnClarification`, "Clarification must pause the SLA clock."));
  }
  const hints = sla.hints;
  if (!Array.isArray(hints) || hints.length === 0) {
    draft.issues.push(issue("sla.hints.missing", `${base}sla.hints`, "At least one SLA hint is required."));
    return;
  }
  hints.forEach((raw, index) => {
    const path = `${base}sla.hints[${index}]`;
    if (!isRecord(raw)) {
      draft.issues.push(issue("sla.hint.not_object", path, "SLA hint must be an object."));
      return;
    }
    if (!isNonEmptyString(raw.key)) {
      draft.issues.push(issue("sla.hint.key.empty", `${path}.key`, "SLA hint key must not be empty."));
    }
    if (!isNonEmptyString(raw.label)) {
      draft.issues.push(issue("sla.hint.label.empty", `${path}.label`, "SLA hint label must not be empty."));
    }
    // Numeric targets are not invented: they stay null until an owner confirms them.
    if (raw.targetMinutes !== null) {
      draft.issues.push(
        issue("sla.hint.numeric_target", `${path}.targetMinutes`, "Numeric SLA targets must stay null until confirmed."),
      );
    }
    if (raw.source !== "unconfigured") {
      draft.issues.push(issue("sla.hint.source", `${path}.source`, "SLA hints must declare source \"unconfigured\"."));
    }
  });
}

function validateOpenQuestions(
  template: Record<string, unknown>,
  base: string,
  draft: TemplateDraft,
): void {
  const questions = template.openQuestions;
  if (!Array.isArray(questions) || questions.length === 0 || !questions.every(isNonEmptyString)) {
    draft.issues.push(issue("open_questions.missing", `${base}openQuestions`, "Open questions for the process owner must be listed."));
  }
}

function validateCrossBoardPolicy(
  template: Record<string, unknown>,
  base: string,
  draft: TemplateDraft,
): void {
  const policy = template.crossBoardTransfer;
  if (!isRecord(policy)) {
    draft.issues.push(issue("cross_board.missing", `${base}crossBoardTransfer`, "Cross-board transfer policy must be declared."));
    return;
  }
  if (policy.allowed !== false) {
    draft.issues.push(issue("cross_board.allowed", `${base}crossBoardTransfer.allowed`, "Cross-board transfer must be forbidden."));
  }
  if (!isNonEmptyString(policy.policy)) {
    draft.issues.push(issue("cross_board.policy.empty", `${base}crossBoardTransfer.policy`, "Cross-board policy text must not be empty."));
  }
}

function validateSingleTemplate(source: string, data: unknown): TemplateDraft {
  const base = `${source}:`;
  const draft: TemplateDraft = {
    key: null,
    activation: null,
    columnKeys: [],
    extraStateKeys: [],
    finalColumnKey: null,
    issues: [],
  };

  if (!isRecord(data)) {
    draft.issues.push(issue("template.not_object", base.slice(0, -1), "Template must be a JSON object."));
    return draft;
  }

  if (!isNonEmptyString(data.key)) {
    draft.issues.push(issue("template.key.empty", `${base}key`, "Template key must be a non-empty string."));
  } else if (!KEBAB_CASE.test(data.key)) {
    draft.issues.push(issue("template.key.format", `${base}key`, "Template key must be kebab-case."));
  } else {
    draft.key = data.key;
  }

  if (!isNonEmptyString(data.name)) {
    draft.issues.push(issue("template.name.empty", `${base}name`, "Template name must not be empty."));
  }
  if (!isNonEmptyString(data.description)) {
    draft.issues.push(issue("template.description.empty", `${base}description`, "Template description must not be empty."));
  }
  if (!isNonEmptyString(data.descriptionHint)) {
    draft.issues.push(issue("template.hint.empty", `${base}descriptionHint`, "A description hint for the request form is required."));
  }
  if (!isNonEmptyString(data.cardUnit)) {
    draft.issues.push(issue("template.card_unit.empty", `${base}cardUnit`, "The card unit of work must be declared."));
  }
  if (data.schemaVersion !== 1) {
    draft.issues.push(issue("template.schema_version", `${base}schemaVersion`, "Unsupported schemaVersion."));
  }

  if (!isNonEmptyString(data.activation)) {
    draft.issues.push(issue("template.activation.missing", `${base}activation`, "Template activation state must be declared."));
  } else if (!(ALLOWED_ACTIVATIONS as readonly string[]).includes(data.activation)) {
    draft.issues.push(
      issue("template.activation.not_allowed", `${base}activation`, "Only declared-not-active or pilot-candidate are allowed."),
    );
  } else {
    draft.activation = data.activation as TemplateActivation;
  }

  validateColumns(data, base, draft);
  validateExtraStates(data, base, draft);
  validateTransitions(data, base, draft);
  validateCrossBoardPolicy(data, base, draft);
  validateVisibility(data, base, draft);
  validateSla(data, base, draft);
  validateOpenQuestions(data, base, draft);

  return draft;
}

/**
 * Validates a set of templates together: per-template structure plus global
 * uniqueness of template keys. Cross-board transfer is rejected both by the
 * explicit policy flag and by refusing qualified or foreign column references.
 */
export function validateTemplateSet(sources: ReadonlyArray<TemplateSource>): ValidationResult {
  const issues: ValidationIssue[] = [];
  const drafts = sources.map((entry) => validateSingleTemplate(entry.source, entry.data));

  const seenTemplateKeys = new Map<string, string>();
  drafts.forEach((draft, index) => {
    if (draft.key === null) return;
    const previous = seenTemplateKeys.get(draft.key);
    if (previous !== undefined) {
      issues.push(
        issue("template.key.duplicate", `${sources[index].source}:key`, `Template key already used by ${previous}.`),
      );
    } else {
      seenTemplateKeys.set(draft.key, sources[index].source);
    }
  });

  if (sources.length === 0) {
    issues.push(issue("templates.empty", "templates", "No templates were provided."));
  }

  const summaries: TemplateSummary[] = [];
  drafts.forEach((draft, index) => {
    issues.push(...draft.issues);
    if (draft.key !== null && draft.activation !== null && draft.finalColumnKey !== null) {
      summaries.push({
        key: draft.key,
        name: String((sources[index].data as Record<string, unknown>).name),
        activation: draft.activation,
        columnKeys: [...draft.columnKeys],
        extraStateKeys: [...draft.extraStateKeys],
        finalColumnKey: draft.finalColumnKey,
      });
    }
  });

  return { ok: issues.length === 0, issues, templates: summaries };
}

/** Convenience wrapper for a single template file. */
export function validateTemplate(source: string, data: unknown): ValidationIssue[] {
  return validateTemplateSet([{ source, data }]).issues;
}
