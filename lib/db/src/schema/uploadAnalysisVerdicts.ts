import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  doublePrecision,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { aiExtractSamplesTable } from "./aiExtractSamples";
import { usersTable } from "./users";

export const uploadAnalysisVerdictsTable = pgTable(
  "upload_analysis_verdicts",
  {
    id: serial("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sampleId: integer("sample_id")
      .notNull()
      .references(() => aiExtractSamplesTable.id, { onDelete: "cascade" }),
    customer: text("customer").notNull(),
    weekStart: text("week_start").notNull(),
    fileName: text("file_name").notNull(),
    lane: text("lane").notNull(),
    verdict: text("verdict").notNull(),
    summary: text("summary").notNull().default(""),
    findings: jsonb("findings").notNull().default([]),
    promptVersion: text("prompt_version").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    toolCalls: integer("tool_calls").notNull().default(0),
    errMsg: text("err_msg"),
    triggeredBy: integer("triggered_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("upload_analysis_verdicts_sample_id_uniq").on(t.sampleId),
    index("upload_analysis_verdicts_week_customer_idx").on(
      t.weekStart,
      t.customer,
    ),
    index("upload_analysis_verdicts_created_at_idx").on(t.createdAt),
  ],
);

export type UploadAnalysisVerdict =
  typeof uploadAnalysisVerdictsTable.$inferSelect;
