/** computeProfileFill — Zenople assignment/transaction rows → profile fields. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeProfileFill } from "../zenopleRates.js";

const driverAsg = {
  AssignmentId: 3167,
  PersonId: 2005279,
  JobId: 813,
  JobPosition: "Driver",
  Organization: "Trienda Holdings",
  PayRate: 25,
  BillRate: 0,
  SSN: "123-45-7888",
  StartDate: "2026-05-01",
  IsActiveToday: true,
};

const customerAsg = {
  AssignmentId: 2541,
  PersonId: 2003283,
  JobId: 559,
  JobPosition: "Production",
  Organization: "Burnett Dairy - Grantsburg",
  PayRate: 21.93,
  BillRate: 31.58,
  SSN: "123-45-5416",
  StartDate: "2026-04-01",
  IsActiveToday: true,
};

test("driver-only person: RT from assignment, OT = 1.5×, bills zeroed", () => {
  const fill = computeProfileFill([driverAsg], []);
  assert.equal(fill.driverRtPayRate, 25);
  assert.equal(fill.driverRtBillRate, 0);
  assert.equal(fill.driverOtPayRate, 37.5);
  assert.equal(fill.driverOtBillRate, 0);
  assert.equal(fill.rtPayRate, undefined);
  assert.equal(fill.assignmentId, 3167);
  assert.equal(fill.jobId, 813);
  assert.equal(fill.personId, 2005279);
  assert.equal(fill.ssn, "XXX-XX-7888");
  assert.equal(fill.zenopleCustomer, "Trienda Holdings");
});

test("dual-lane person: driver OT bases on the customer RT rate (seed rule)", () => {
  const fill = computeProfileFill(
    [customerAsg, { ...driverAsg, PayRate: 10, PersonId: 2003283 }],
    [],
  );
  assert.equal(fill.rtPayRate, 21.93);
  assert.equal(fill.rtBillRate, 31.58);
  assert.equal(fill.otPayRate, 32.9); // 1.5 × 21.93 rounded
  assert.equal(fill.otBillRate, undefined); // bill OT only from actuals
  assert.equal(fill.driverRtPayRate, 10);
  assert.equal(fill.driverOtPayRate, 32.9); // 1.5 × customer RT, not 1.5 × 10
  // identifiers prefer the CUSTOMER assignment (reference-workbook rule)
  assert.equal(fill.assignmentId, 2541);
  assert.equal(fill.jobId, 559);
  // customer name comes from the customer lane
  assert.equal(fill.zenopleCustomer, "Burnett Dairy - Grantsburg");
});

test("identity prefers the ACTIVE assignment: ended customer role loses to active driver (Disla)", () => {
  const fill = computeProfileFill(
    [
      {
        ...customerAsg,
        AssignmentId: 3108,
        JobId: 793,
        Organization: "International Wire Group, Inc",
        IsActiveToday: false,
        StartDate: "2026-01-01",
      },
      {
        ...driverAsg,
        AssignmentId: 3418,
        JobId: 862,
        PayRate: 0, // unrated driver assignment — rate must come from actuals
        Organization: "International Wire Group, Inc",
        IsActiveToday: true,
      },
    ],
    [
      {
        PersonId: 2005201,
        JobPosition: "Driver",
        RTPay: 199.36,
        RTPayHours: 12.46,
        RTBill: 0,
        RTBillHours: 0,
        OTPay: 0,
        OTPayHours: 0,
        OTBill: 0,
        OTBillHours: 0,
      },
    ],
  );
  assert.equal(fill.assignmentId, 3418);
  assert.equal(fill.jobId, 862);
  assert.equal(fill.driverRtPayRate, 16); // 199.36 / 12.46 from actuals
});

test("effective OT rates come from transaction actuals when present", () => {
  const fill = computeProfileFill(
    [customerAsg],
    [
      {
        PersonId: 2003283,
        JobPosition: "Production",
        RTPay: 877.2,
        RTPayHours: 40,
        RTBill: 1263.2,
        RTBillHours: 40,
        OTPay: 164.5,
        OTPayHours: 5,
        OTBill: 217.15,
        OTBillHours: 5,
      },
    ],
  );
  assert.equal(fill.otPayRate, 32.9); // 164.50 / 5
  assert.equal(fill.otBillRate, 43.43); // 217.15 / 5
});

test("no assignment: RT falls back to transaction effective rates", () => {
  const fill = computeProfileFill(
    [],
    [
      {
        PersonId: 1,
        JobPosition: "Driver",
        RTPay: 655.5,
        RTPayHours: 26.22,
        RTBill: 0,
        RTBillHours: 0,
        OTPay: 0,
        OTPayHours: 0,
        OTBill: 0,
        OTBillHours: 0,
      },
    ],
  );
  assert.equal(fill.driverRtPayRate, 25); // 655.50 / 26.22
  assert.equal(fill.driverRtBillRate, undefined); // no bill hours → unknown
});

test("nothing known → empty fill (no invented zeros)", () => {
  const fill = computeProfileFill([], []);
  for (const v of Object.values(fill)) assert.equal(v, undefined);
});
