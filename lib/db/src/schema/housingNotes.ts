import {
  pgTable, serial, integer, text, numeric, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core";

/**
 * A payroll change that was DISCUSSED, filed by hand in the KFI Housing app.
 *
 * Brad, 2026-09-16: *"The goal is to put changes in that are discussed,
 * something that cannot be done auto."* A coordinator picks a person in
 * Housing, the app fills in where that person is, she says what payroll must
 * do and types what happened ("he abandoned the job"). It lands here as a task
 * for the pay period.
 *
 * ⚠️⚠️ WHY THIS IS NOT A `payroll_changes` ROW. That table is the MAIL SWEEP's
 * ledger and three of its properties are actively wrong for this:
 *  1. `rowKeyFor` hashes conversation + person + type + week. Housing has no
 *     conversation, so two genuine notes about one person in one week would
 *     collapse into one row — and `HUMAN_OWNED` would then carry the first
 *     one's verification forward, so the SECOND task would arrive pre-ticked.
 *     Here the originator mints the key (see `noteKey`), so that cannot happen.
 *  2. It is unique on (period, rowKey) with the period IN the key, so an
 *     unhandled row can never be carried to the next period.
 *  3. The Changes board sends every row's employee + action to the model for a
 *     terse label. "Ramirez — he abandoned the job" is not text to ship off
 *     platform as a side effect of storing it.
 *
 * ⚠️ HOUSING OWNS EVERY FACT HERE; THIS APP OWNS ONLY `handled*`. The upsert
 * that receives a push lists the facts and deliberately OMITS the three
 * handled columns — the same discipline as the sweep omitting the counts and
 * notes (machinePayroll.ts). Housing re-pushes on every board open, and a
 * re-push must never un-tick Tiana's work.
 */
export const housingNotesTable = pgTable(
  "housing_notes",
  {
    id: serial("id").primaryKey(),
    periodId: integer("period_id").notNull(),

    /**
     * Idempotency key, minted by Housing (a uuid) when the coordinator pressed
     * Save. ⚠️ NOT derived from the content: a human press is the identity, so
     * two deliberate notes about one person in one week are two tasks. A
     * content hash would silently merge them.
     */
    noteKey: text("note_key").notNull(),

    /**
     * Zenople PersonId — the ONLY key anything is allowed to join on here, and
     * the reason it is NOT NULL: a note whose person cannot be resolved is
     * REFUSED at the door with a named reason, never stored with a null key
     * and quietly rendered as a task nobody can action.
     */
    personId: integer("person_id").notNull(),
    personName: text("person_name").notNull(),

    /** What Housing's coordinator said payroll must do, in her vocabulary. */
    ask: text("ask").notNull(),
    /** The canonical taxonomy type this `ask` maps onto; null when it needs saying. */
    changeType: text("change_type"),
    /** Ops | TMS | 2TMS | PAS — which day of the week's work this lands on. */
    route: text("route"),
    /** Her own words. The whole point of the record. */
    note: text("note").notNull(),

    /**
     * ⚠️ WHERE THE PERSON WAS WHEN THE NOTE WAS WRITTEN — a frozen snapshot,
     * never a live join. By the time this is read Housing may well have moved
     * them out, which is usually the very thing the note is about; a live read
     * would show an empty bed and the instruction would lose its subject.
     * (Same doctrine as `van_riders.name` in the Housing app.)
     */
    customer: text("customer"),
    shift: text("shift"),
    propertyName: text("property_name"),
    roomLabel: text("room_label"),
    bedLabel: text("bed_label"),
    vanLabel: text("van_label"),
    vanRole: text("van_role"),
    weeklyRent: numeric("weekly_rent", { precision: 8, scale: 2 }),
    /** What payroll was last seen deducting, and which pay week that was. */
    deducted: numeric("deducted", { precision: 8, scale: 2 }),
    deductedWeek: text("deducted_week"),

    /** The Saturday pay-week end Housing filed it against, as Housing keys weeks. */
    payWeekEnd: text("pay_week_end").notNull(),

    byEmail: text("by_email"),
    notedAt: timestamp("noted_at", { withTimezone: true }),

    /**
     * Housing retracted it. ⚠️ Shown, never deleted — a row that vanishes from
     * a queue after somebody may already have keyed it is worse than one that
     * says "retracted, verify".
     */
    voidedAt: timestamp("voided_at", { withTimezone: true }),

    /**
     * ⚠️ THIS APP OWNS THESE THREE AND NOTHING ELSE WRITES THEM. They are what
     * travels back to Housing so the coordinator can see it was actioned.
     */
    handledAt: timestamp("handled_at", { withTimezone: true }),
    handledBy: text("handled_by"),
    handledNote: text("handled_note"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    // The upsert target. A re-push of the same note updates its facts in place.
    uniqueIndex("housing_notes_note_key_idx").on(t.periodId, t.noteKey),
    index("housing_notes_period_idx").on(t.periodId),
    index("housing_notes_handled_idx").on(t.handledAt),
    index("housing_notes_person_idx").on(t.personId),
  ],
);

export type HousingNote = typeof housingNotesTable.$inferSelect;
