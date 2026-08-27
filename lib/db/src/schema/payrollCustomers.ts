import {
  pgTable, serial, text, integer, boolean, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core";

/**
 * The customer roster for the payroll run.
 *
 * ⚠️ The roster GROWS — 18 customers in April 2026, 28 by August. Never
 * hardcode it. Rows are seeded from Zenople `TransactionData.Organization`
 * (the canonical name) and carry the two other names the same customer wears:
 * the abbreviation used in template filenames (`SGCG`, `AT Owatonna`) and
 * whatever tokens have actually appeared on disk, which drift in case and
 * spelling (`Shuster`/`Shusters`, `Monday batch`/`Monday Batch`).
 */
export const payrollCustomersTable = pgTable(
  "payroll_customers",
  {
    id: serial("id").primaryKey(),
    /** Exactly as Zenople reports it, e.g. "Cardinal CG - Spring Green". */
    zenopleName: text("zenople_name").notNull(),
    /** The token used in template filenames, e.g. "SGCG". */
    fileToken: text("file_token"),
    /** Display name for the board. Defaults to zenopleName. */
    displayName: text("display_name"),
    /**
     * How this customer's time arrives:
     *   zenople  — kept in Zenople directly. ⚠️ Alamco, Bell Lumber and
     *              Shusters. They have NO `Client TS` files at all and show up
     *              only in Transaction Batches, so a missing timesheet is
     *              expected, not an exception. After any rate change they also
     *              need TMS > batch > select > update transactions.
     *   template — we send a template, they send hours back (the majority).
     *   none     — no template is sent; goes straight on the no-hours list.
     */
    timekeepingMode: text("timekeeping_mode").notNull().default("template"),
    /** Skip the Friday template send for this customer. */
    sendsTemplate: boolean("sends_template").notNull().default(true),
    contactEmails: text("contact_emails").array(),
    /** Free-text processing quirks surfaced on the Hours Intake board. */
    notes: text("notes"),
    active: boolean("active").notNull().default(true),
    firstSeenPayDate: text("first_seen_pay_date"),
    lastSeenPayDate: text("last_seen_pay_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("payroll_customers_zenople_idx").on(t.zenopleName),
    index("payroll_customers_token_idx").on(t.fileToken),
    index("payroll_customers_active_idx").on(t.active),
  ],
);

export type PayrollCustomer = typeof payrollCustomersTable.$inferSelect;

/**
 * Every spelling of a customer that has appeared on disk or in a file.
 *
 * ⚠️ Filenames are NOT a reliable key. Classify against this table; never
 * exact-match a customer out of a filename.
 */
export const payrollCustomerAliasesTable = pgTable(
  "payroll_customer_aliases",
  {
    id: serial("id").primaryKey(),
    customerId: integer("customer_id").notNull(),
    /** Lower-cased, whitespace-collapsed. */
    alias: text("alias").notNull(),
    /** Where it was seen: filename | email | zenople | manual. */
    source: text("source").notNull().default("filename"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payroll_customer_alias_idx").on(t.alias),
    index("payroll_customer_alias_cust_idx").on(t.customerId),
  ],
);

export type PayrollCustomerAlias = typeof payrollCustomerAliasesTable.$inferSelect;
