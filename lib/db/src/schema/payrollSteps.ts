import { pgTable, serial, text, integer, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";

/**
 * The 51-step checklist, as data.
 *
 * Lifted verbatim from the `Checklist` tab of `Payroll changes for PD
 * MM.DD.YYYY.xlsx`, which is the real specification for the weekly run — the
 * Processes/ SOP folder documents these same steps but is incomplete in
 * exactly the places that matter most.
 *
 * Two levels: a step may be a subtask of another (the tab indents them). Order
 * is the tab's own order, which is the order the work actually happens in.
 */
export const payrollStepsTable = pgTable(
  "payroll_steps",
  {
    id: serial("id").primaryKey(),
    /** Stable slug — state rows reference this, so never renumber. */
    key: text("key").notNull(),
    ordinal: integer("ordinal").notNull(),
    /** "Friday" | "Monday" | "Monday/Tuesday" | ... as written on the tab. */
    day: text("day").notNull(),
    task: text("task").notNull(),
    /** Parent step id when this is an indented subtask. */
    parentId: integer("parent_id"),
    /** Which tile owns this step, so a tile can show just its own slice. */
    tile: text("tile"),
    /** Off-cycle periods skip most steps. */
    appliesOffCycle: boolean("applies_off_cycle").notNull().default(false),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("payroll_steps_key_idx").on(t.key),
    index("payroll_steps_ordinal_idx").on(t.ordinal),
  ],
);

export type PayrollStep = typeof payrollStepsTable.$inferSelect;
