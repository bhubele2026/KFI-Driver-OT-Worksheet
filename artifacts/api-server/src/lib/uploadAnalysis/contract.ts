/**
 * Task #444 — upload-analysis contract.
 *
 * Single source of truth for the per-upload "commentator" pass that
 * Phase 1 will wire into the upload routes. Imported by:
 *
 *   - `scripts/prototypeUploadAnalysis.ts` (Task #444 prototype runner)
 *   - the future Phase-1 analysis function (post-prototype)
 *
 * The contract is intentionally minimal: a closed verdict (`ok | warn | fail`),
 * a closed enum of exactly five finding kinds, an explicit `lane` field on
 * the top-level verdict, and a system prompt that bakes in the parser-lane
 * asymmetry confirmed in `.local/prototype/parser-path-stash-audit.md`.
 *
 * Iteration discipline: the schema is FIXED. The prototype iterates on
 * prompt quality only. If grading turns up a class of useful findings that
 * doesn't fit one of the five kinds, that's a Phase 1 decision, not a
 * prototype-loop decision. Bump `PROMPT_VERSION` on every prompt edit; the
 * runner writes both verdicts and rubric files keyed by it so iterations
 * are diffable.
 */

import { z } from "zod/v4";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Bump on EVERY prompt edit. `v1.0` is the first checked-in draft —
 * bump to `v1.1` for a small wording tweak, `v2.0` for a structural
 * rework. The runner writes `.local/prototype/upload-analysis-verdicts-<v>.json`
 * and `.local/prototype/grading-rubric-<v>.md` keyed by this string,
 * so a re-run after a prompt change is diffable on disk.
 */
export const PROMPT_VERSION = "v1.0";

/** The closed set of finding kinds. Pinned by Task #444, Step 2. */
export const FINDING_KINDS = [
  "extraction_completeness",
  "roster_match_quality",
  "hours_anomaly",
  "missing_or_new_driver",
  "structural_concern",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const SEVERITY = ["info", "warn", "fail"] as const;
export type Severity = (typeof SEVERITY)[number];

export const VERDICTS = ["ok", "warn", "fail"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const LANES = ["ai", "parser"] as const;
export type Lane = (typeof LANES)[number];

/**
 * Zod schema the runner validates Claude's `submit_analysis` payload
 * against. Phase 1 will reuse this verbatim. Schema is closed: any
 * extra fields the model emits are stripped.
 */
export const findingSchema = z
  .object({
    kind: z.enum(FINDING_KINDS),
    severity: z.enum(SEVERITY),
    message: z.string().min(1).max(500),
    evidence: z
      .object({
        rowIds: z.array(z.union([z.string(), z.number()])).optional(),
        driver: z.string().optional(),
        date: z.string().optional(),
        kfiId: z.string().optional(),
        note: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Finding = z.infer<typeof findingSchema>;

export const verdictPayloadSchema = z
  .object({
    verdict: z.enum(VERDICTS),
    /**
     * Sign-off from Task #444 user reply: `lane` is a top-level field
     * on the verdict so grading can distinguish "missing finding by
     * design" (parser uploads never emit `roster_match_quality`) from
     * "missing finding that's an actual miss". Cheap to add now,
     * expensive to backfill.
     */
    lane: z.enum(LANES),
    summary: z.string().min(1).max(280),
    findings: z.array(findingSchema).max(20),
  })
  .strict();
export type VerdictPayload = z.infer<typeof verdictPayloadSchema>;

/**
 * The single tool the model is required to call as its final step.
 * The runner forces tool_choice to this tool on the last turn if the
 * model didn't reach it on its own.
 */
export const SUBMIT_ANALYSIS_TOOL_NAME = "submit_analysis" as const;

export function submitAnalysisToolDef(): Anthropic.Messages.Tool {
  return {
    name: SUBMIT_ANALYSIS_TOOL_NAME,
    description:
      "Submit the final upload analysis. Call this exactly once as your last action. " +
      "Do NOT call this until you have read the file rows (and raw text if needed) at least once.",
    input_schema: {
      type: "object",
      properties: {
        verdict: {
          type: "string",
          enum: [...VERDICTS],
          description:
            "ok = looks clean. warn = at least one finding the dispatcher should glance at. fail = at least one finding that almost certainly needs the dispatcher to act.",
        },
        lane: {
          type: "string",
          enum: [...LANES],
          description:
            "Which extraction lane produced this upload. The runner passes this in the system prompt; echo it back exactly.",
        },
        summary: {
          type: "string",
          description:
            "ONE sentence the dispatcher will see before clicking through. Concrete; no preamble.",
        },
        findings: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: [...FINDING_KINDS] },
              severity: { type: "string", enum: [...SEVERITY] },
              message: {
                type: "string",
                description:
                  "ONE sentence. State the finding, not what you're about to do. Include the driver / date / count when relevant.",
              },
              evidence: {
                type: "object",
                properties: {
                  rowIds: {
                    type: "array",
                    items: { type: ["string", "number"] },
                  },
                  driver: { type: "string" },
                  date: { type: "string" },
                  kfiId: { type: "string" },
                  note: { type: "string" },
                },
              },
            },
            required: ["kind", "severity", "message"],
          },
        },
      },
      required: ["verdict", "lane", "summary", "findings"],
    },
  };
}

export interface SystemPromptInput {
  customer: string;
  weekStart: string;
  lane: Lane;
  /**
   * True when this is the first confirmed upload we have for this
   * customer. Suppresses `hours_anomaly` since there's no history to
   * compare against. The runner derives this from a quick count of
   * prior confirmed `ai_extract_samples` rows for the same customer.
   */
  isFirstUpload: boolean;
}

/**
 * The analysis system prompt. Voice and structure mirror the existing
 * `runChatTurn` system prompt: terse, third-person, read-first. Lane
 * asymmetry is baked in per the user's Step 1 sign-off:
 *
 *   - parser samples → NEVER emit `roster_match_quality`. The parser
 *     lane is ID-centric and `pendingRows` is structurally empty;
 *     hedging would be noise, silence is cleaner.
 *   - first-upload customers → NEVER emit `hours_anomaly`. No history
 *     to compare against; the finding kind exists, the prompt just
 *     declines to use it.
 */
export function buildAnalysisSystemPrompt(input: SystemPromptInput): string {
  const laneRules =
    input.lane === "parser"
      ? [
          `## Lane: parser`,
          `This upload was imported by the deterministic role-based parser, not the AI extractor. Two consequences:`,
          `- DO NOT emit \`roster_match_quality\` findings on this upload. The parser is ID-centric; \`pendingRows\` is structurally always empty here. Silence is correct.`,
          `- A row that the parser dropped will show up in \`droppedRows\` (typed reason: \`no_driver_match\`, \`outside_week\`, \`extraction_failed\`). Use those for \`extraction_completeness\` and \`missing_or_new_driver\` findings as appropriate.`,
        ]
      : [
          `## Lane: ai`,
          `This upload was extracted by the AI extractor. \`pendingRows\` is authoritative — every row in it is a real row the extractor saw but couldn't resolve to a kfiId. Use it for \`roster_match_quality\` findings.`,
        ];

  const historyRule = input.isFirstUpload
    ? [
        `## History: none`,
        `This is the first confirmed upload we have on file for "${input.customer}". DO NOT emit \`hours_anomaly\` findings — there is no baseline to compare against. The kind exists; this upload just doesn't have the data for it.`,
      ]
    : [
        `## History: available`,
        `Prior confirmed uploads exist for "${input.customer}". \`hours_anomaly\` findings are appropriate when a driver's weekly total looks materially off versus past weeks. You don't have direct access to past totals from here — only flag an anomaly if the current upload's own totals are self-evidently strange (e.g. a single driver at 72h on a 7-day week).`,
      ];

  return [
    `Upload-analysis commentator embedded in the KFI Driver OT Worksheet. Scope: customer "${input.customer}", payroll week starting ${input.weekStart}. Your job is to COMMENT on what just landed, not to propose fixes. The dispatcher will read your findings; another surface handles fixes.`,
    ``,
    `## What you are doing`,
    `One upload just got confirmed. Read the rows the extractor produced, optionally inspect the raw file text, then emit a short structured verdict via \`${SUBMIT_ANALYSIS_TOOL_NAME}\`. Keep it tight — the dispatcher will glance, not read.`,
    ``,
    `## How to investigate (do this before submitting)`,
    `1. Call \`read_upload_file_rows\` with NO filters first to see the full extraction (resolved + pending + dropped counts). This is one cheap call and grounds everything that follows.`,
    `2. If anything looks off — counts that don't add up, a date outside the week, a driver name that recurs in droppedRows — call \`read_upload_file_raw\` ONCE to spot-check the source. Don't read the raw file just to confirm what \`read_upload_file_rows\` already showed you.`,
    `3. You have a hard budget of 8 read calls and 200 KB per analysis. Stay well under it; 2–3 calls is the normal shape.`,
    ``,
    ...laneRules,
    ``,
    ...historyRule,
    ``,
    `## Finding kinds (closed enum — exactly these five)`,
    `- \`extraction_completeness\`: rows present in the source file that didn't land in the extraction, or vice versa. Example: "5 rows in source not in preview" / "preview has 2 rows with no source match".`,
    `- \`roster_match_quality\`: confidence the badge / name → kfiId matches are right. AI lane only (see above).`,
    `- \`hours_anomaly\`: per-driver weekly total that looks self-evidently off. Skip if history is unavailable (see above).`,
    `- \`missing_or_new_driver\`: drivers expected but absent (rare — only call this out if a dropped-row reason makes it obvious), or a badge / name-on-doc that looks like it's never been seen for this customer before.`,
    `- \`structural_concern\`: file-level oddities. Span > 7 days; customer name in the file header doesn't match selected customer; same driver appears in both resolved AND pending rows; a column / sheet that looks like real data was not extracted at all.`,
    ``,
    `If a real-world finding doesn't fit one of these five, DROP IT. Do not invent a sixth kind, do not stretch a kind, do not append it to \`summary\`. We will expand the enum in Phase 1 if a class of useful findings keeps appearing that genuinely can't be expressed.`,
    ``,
    `## Severity`,
    `- \`info\`: worth knowing, not worth interrupting. Verdict can still be \`ok\`.`,
    `- \`warn\`: dispatcher should glance and decide. Verdict is at least \`warn\`.`,
    `- \`fail\`: dispatcher almost certainly needs to act. Verdict is \`fail\`.`,
    ``,
    `## Verdict rules`,
    `- \`ok\`: no findings, or only \`info\` findings.`,
    `- \`warn\`: at least one \`warn\` finding and no \`fail\` findings.`,
    `- \`fail\`: at least one \`fail\` finding.`,
    ``,
    `## Voice`,
    `Terse, third-person, no preamble. State each finding as one sentence with the concrete driver / date / count in it. Don't narrate your tool calls. Don't apologize for uncertainty — if you're uncertain, drop the finding.`,
    ``,
    `## Bad vs good`,
    `BAD: "I looked at the rows and it seems like Willie Medina might be missing a punch."`,
    `GOOD: "Willie Medina has no punches on 2026-05-21 but is present every other day this week."`,
    ``,
    `## Output`,
    `Your final action MUST be a call to \`${SUBMIT_ANALYSIS_TOOL_NAME}\` with \`lane: "${input.lane}"\`. Echo the lane exactly as given. Do not call \`${SUBMIT_ANALYSIS_TOOL_NAME}\` before you have called at least one read tool. Empty \`findings\` array is fine — silence with verdict \`ok\` is the correct output for a clean upload.`,
  ].join("\n");
}
