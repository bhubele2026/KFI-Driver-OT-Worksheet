import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";

// Per-driver Zenople identity + pay/bill rate row used to build the
// weekly Zenople payroll export. Optional on every driver: a driver
// only needs a profile if you want them included in the export. The
// readiness gate on /weeks/:weekStart/zenople-readiness fails for any
// driver in the week with hours > 0 that doesn't have a fully-filled
// profile (SSN + JobId + PersonId + Assignment Id + the four pay/bill
// pairs).
//
// `updatedBy` records the dispatcher who last touched the rates so the
// driver-detail card can render attribution. `updatedAt` is auto-bumped
// by Drizzle's $onUpdate hook.
export const driverPayrollProfilesTable = pgTable(
  "driver_payroll_profiles",
  {
    kfiId: text("kfi_id").primaryKey(),
    ssn: text("ssn"),
    jobId: integer("job_id"),
    personId: integer("person_id"),
    assignmentId: integer("assignment_id"),
    zenopleCustomer: text("zenople_customer"),
    rtPayRate: numeric("rt_pay_rate", { precision: 8, scale: 4 }),
    rtBillRate: numeric("rt_bill_rate", { precision: 8, scale: 4 }),
    otPayRate: numeric("ot_pay_rate", { precision: 8, scale: 4 }),
    otBillRate: numeric("ot_bill_rate", { precision: 8, scale: 4 }),
    driverRtPayRate: numeric("driver_rt_pay_rate", { precision: 8, scale: 4 }),
    driverRtBillRate: numeric("driver_rt_bill_rate", { precision: 8, scale: 4 }),
    driverOtPayRate: numeric("driver_ot_pay_rate", { precision: 8, scale: 4 }),
    driverOtBillRate: numeric("driver_ot_bill_rate", { precision: 8, scale: 4 }),
    updatedBy: integer("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export type DriverPayrollProfile =
  typeof driverPayrollProfilesTable.$inferSelect;
