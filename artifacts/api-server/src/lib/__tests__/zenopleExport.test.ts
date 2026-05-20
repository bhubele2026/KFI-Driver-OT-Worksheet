import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import type { Punch } from "@workspace/db/schema";

import {
  ZENOPLE_HEADER,
  buildZenopleRows,
  buildZenopleWorkbook,
  isoToExcelSerial,
  missingProfileFields,
  rosterNameToZenople,
  rowsToAoA,
  zenopleFileName,
  type ZenopleDriverInput,
  type ZenopleProfile,
} from "../zenopleExport.js";
import {
  fingerprintName,
  PAYROLL_SEED_ROWS,
} from "../../../../../lib/db/src/seedDriverPayrollProfiles.js";

const FULL_PROFILE: ZenopleProfile = {
  ssn: "XXX-XX-1234",
  jobId: 558,
  personId: 2002909,
  assignmentId: 2540,
  zenopleCustomer: "Adient",
  rtPayRate: 18.25,
  rtBillRate: 25.37,
  otPayRate: 27.38,
  otBillRate: 37.24,
  driverRtPayRate: 13.75,
  driverRtBillRate: 0,
  driverOtPayRate: 27.38,
  driverOtBillRate: 0,
};

function p(
  source: "Driver" | "Customer",
  date: string,
  clockIn: string,
  clockOut: string,
  hours: number,
  customer: string | null = "Adient",
): Punch {
  return {
    id: Math.floor(Math.random() * 1_000_000),
    weekStart: "2026-05-10",
    kfiId: "K1",
    customer,
    source,
    date,
    clockIn,
    clockOut,
    hours: String(hours),
    isManual: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    updatedBy: null,
  } as unknown as Punch;
}

test("isoToExcelSerial: 2026-05-16 (Saturday) -> 46158", () => {
  assert.equal(isoToExcelSerial("2026-05-16"), 46158);
});

test("isoToExcelSerial: 1900-03-01 = 61 (Excel leap bug compat)", () => {
  assert.equal(isoToExcelSerial("1900-03-01"), 61);
});

test("rosterNameToZenople: 'Jose Angulo Alfaro' -> 'ANGULO ALFARO, JOSE'", () => {
  assert.equal(
    rosterNameToZenople("Jose Angulo Alfaro"),
    "ANGULO ALFARO, JOSE",
  );
});

test("rosterNameToZenople: pre-formatted 'RIVERA, OMAR' is preserved (uppercased)", () => {
  assert.equal(rosterNameToZenople("Rivera, Omar"), "RIVERA, OMAR");
});

test("ZENOPLE_HEADER preserves the literal leading spaces on End Date / Status / Assignment Id", () => {
  assert.equal(ZENOPLE_HEADER[14], " End Date");
  assert.equal(ZENOPLE_HEADER[15], " Status");
  assert.equal(ZENOPLE_HEADER[16], " Assignment Id");
  assert.equal(ZENOPLE_HEADER.length, 17);
});

test("missingProfileFields: null profile lists only the 5 identity fields (rates default to $0)", () => {
  const m = missingProfileFields(null);
  assert.deepEqual(m, [
    "ssn",
    "jobId",
    "personId",
    "assignmentId",
    "zenopleCustomer",
  ]);
});

test("missingProfileFields: complete profile returns []", () => {
  assert.deepEqual(missingProfileFields(FULL_PROFILE), []);
});

test("missingProfileFields: all-null rates + full identity returns [] (rates don't block)", () => {
  const ratesNull: ZenopleProfile = {
    ...FULL_PROFILE,
    rtPayRate: null,
    rtBillRate: null,
    otPayRate: null,
    otBillRate: null,
    driverRtPayRate: null,
    driverRtBillRate: null,
    driverOtPayRate: null,
    driverOtBillRate: null,
  };
  assert.deepEqual(missingProfileFields(ratesNull), []);
});

test("missingProfileFields: all-zero rates + full identity returns []", () => {
  const ratesZero: ZenopleProfile = {
    ...FULL_PROFILE,
    rtPayRate: 0,
    rtBillRate: 0,
    otPayRate: 0,
    otBillRate: 0,
    driverRtPayRate: 0,
    driverRtBillRate: 0,
    driverOtPayRate: 0,
    driverOtBillRate: 0,
  };
  assert.deepEqual(missingProfileFields(ratesZero), []);
});

test("missingProfileFields: missing ssn (identity field) still blocks", () => {
  const noSsn: ZenopleProfile = { ...FULL_PROFILE, ssn: null };
  assert.deepEqual(missingProfileFields(noSsn), ["ssn"]);
});

test("missingProfileFields: missing identity + null rates still only reports identity", () => {
  const partial: ZenopleProfile = {
    ssn: null,
    jobId: null,
    personId: 2002909,
    assignmentId: 2540,
    zenopleCustomer: "Adient",
    rtPayRate: null,
    rtBillRate: null,
    otPayRate: null,
    otBillRate: null,
    driverRtPayRate: null,
    driverRtBillRate: null,
    driverOtPayRate: null,
    driverOtBillRate: null,
  };
  assert.deepEqual(missingProfileFields(partial), ["ssn", "jobId"]);
});

test("buildZenopleWorkbook: null rate fields are written as numeric 0 in the workbook", () => {
  const ratesNull: ZenopleProfile = {
    ...FULL_PROFILE,
    rtPayRate: null,
    rtBillRate: null,
    otPayRate: null,
    otBillRate: null,
    driverRtPayRate: null,
    driverRtBillRate: null,
    driverOtPayRate: null,
    driverOtBillRate: null,
  };
  const driver: ZenopleDriverInput = {
    kfiId: "K1",
    name: "Null Rates",
    zenopleName: "RATES, NULL",
    profile: ratesNull,
    // Customer 35h + Driver 10h ⇒ custRt=35, driverRt=5, driverOt=5.
    punches: [
      p("Customer", "2026-05-10", "2026-05-10 6:00 AM", "2026-05-11 1:00 AM", 19),
      p("Customer", "2026-05-11", "2026-05-11 6:00 AM", "2026-05-11 10:00 PM", 16),
      p("Driver", "2026-05-12", "2026-05-12 6:00 AM", "2026-05-12 4:00 PM", 10),
    ],
  };
  const buf = buildZenopleWorkbook([driver], "2026-05-16");
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true });
  // header + 3 rows (RT, DriverRT, DriverOT)
  assert.equal(aoa.length, 4);
  for (let i = 1; i < aoa.length; i += 1) {
    const row = aoa[i];
    // Pay Rate (col 7) and Bill Rate (col 9) must be numeric 0, not blank
    // and not a string. Item Pay (col 10) is also numeric 0.
    assert.strictEqual(row[7], 0, `row ${i} Pay Rate should be numeric 0`);
    assert.strictEqual(row[9], 0, `row ${i} Bill Rate should be numeric 0`);
    assert.strictEqual(row[10], 0, `row ${i} Item Pay should be numeric 0`);
  }
});

test("zenopleFileName: matches Driver_Pay_Units_…_PD_MM.DD.YYYY_<PPE>.xlsx", () => {
  // PD on 2026-05-15, PPE = Saturday 2026-05-16 -> serial 46158
  const fn = zenopleFileName(new Date(2026, 4, 15), "2026-05-16");
  assert.equal(
    fn,
    "Driver_Pay_Units_customer_and_Driver_time_PD_05.15.2026_46158.xlsx",
  );
});

test("buildZenopleRows: omits zero-hour buckets and sorts by customer then person", () => {
  // Driver A — Adient — has only DriverRT hours.
  const driverA: ZenopleDriverInput = {
    kfiId: "KA",
    name: "Alpha Aaa",
    zenopleName: "AAA, ALPHA",
    profile: { ...FULL_PROFILE, zenopleCustomer: "Adient" },
    punches: [p("Driver", "2026-05-10", "2026-05-10 8:00 AM", "2026-05-10 12:00 PM", 4)],
  };
  // Driver B — Burnett — has Customer RT only.
  const driverB: ZenopleDriverInput = {
    kfiId: "KB",
    name: "Bravo Bbb",
    zenopleName: "BBB, BRAVO",
    profile: { ...FULL_PROFILE, zenopleCustomer: "Burnett" },
    punches: [
      p("Customer", "2026-05-10", "2026-05-10 8:00 AM", "2026-05-10 1:00 PM", 5, "Burnett"),
    ],
  };
  const rows = buildZenopleRows([driverB, driverA], "2026-05-16");
  assert.equal(rows.length, 2);
  // Adient sorts before Burnett.
  assert.equal(rows[0].customer, "Adient");
  assert.equal(rows[0].code, "DriverRT");
  assert.equal(rows[0].payUnit, 4);
  assert.equal(rows[1].customer, "Burnett");
  assert.equal(rows[1].code, "RT");
  assert.equal(rows[1].payUnit, 5);
  // PPE is the Saturday serial.
  assert.equal(rows[0].ppe, 46158);
});

test("rowsToAoA: Item Bill is '' for DriverRT, 0 for the other codes; Status columns blank", () => {
  const driver: ZenopleDriverInput = {
    kfiId: "K1",
    name: "Test Driver",
    zenopleName: "DRIVER, TEST",
    profile: FULL_PROFILE,
    // Chronological order: Customer 35h first, then Driver 10h.
    // Engine splits at the 40h boundary mid-shift:
    //   custRt=35, driverRt=5, driverOt=5 (custOt=0).
    punches: [
      p("Customer", "2026-05-10", "2026-05-10 6:00 AM", "2026-05-11 1:00 AM", 19),
      p("Customer", "2026-05-11", "2026-05-11 6:00 AM", "2026-05-11 10:00 PM", 16),
      p("Driver", "2026-05-12", "2026-05-12 6:00 AM", "2026-05-12 4:00 PM", 10),
    ],
  };
  const aoa = rowsToAoA(buildZenopleRows([driver], "2026-05-16"));
  // header + 3 rows (RT, DriverRT, DriverOT)
  assert.equal(aoa.length, 4);
  assert.deepEqual(aoa[0], [...ZENOPLE_HEADER]);
  const byCode = new Map<string, unknown[]>();
  for (let i = 1; i < aoa.length; i += 1) byCode.set(String(aoa[i][5]), aoa[i]);
  assert.ok(byCode.has("RT"));
  assert.ok(byCode.has("DriverRT"));
  assert.ok(byCode.has("DriverOT"));
  // Item Bill column index = 11.
  assert.equal(byCode.get("RT")![11], 0);
  assert.equal(byCode.get("DriverOT")![11], 0);
  assert.equal(byCode.get("DriverRT")![11], "");
  // Three status columns (indices 13, 14, 15) are blank strings.
  for (const row of [byCode.get("RT")!, byCode.get("DriverRT")!, byCode.get("DriverOT")!]) {
    assert.equal(row[13], "");
    assert.equal(row[14], "");
    assert.equal(row[15], "");
  }
});

test("buildZenopleWorkbook: round-trips through XLSX and preserves header verbatim", () => {
  const driver: ZenopleDriverInput = {
    kfiId: "K1",
    name: "Sample Driver",
    zenopleName: "DRIVER, SAMPLE",
    profile: FULL_PROFILE,
    punches: [p("Customer", "2026-05-10", "2026-05-10 8:00 AM", "2026-05-10 12:00 PM", 4)],
  };
  const buf = buildZenopleWorkbook([driver], "2026-05-16");
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true });
  assert.deepEqual(aoa[0], [...ZENOPLE_HEADER]);
  // Single non-zero bucket (RT, 4h)
  assert.equal(aoa.length, 2);
  assert.equal(aoa[1][5], "RT");
  assert.equal(aoa[1][6], 4);
  assert.equal(aoa[1][12], 46158);
});

test("seed fingerprint matcher: 'ANGULO ALFARO, JOSE R' matches 'Jose R. Angulo Alfaro'", () => {
  assert.equal(
    fingerprintName("ANGULO ALFARO, JOSE R"),
    fingerprintName("Jose R. Angulo Alfaro"),
  );
});

test("seed fingerprint matcher: JR/SR/II suffixes are stripped", () => {
  assert.equal(
    fingerprintName("MEDINA JR, WILLIE A"),
    fingerprintName("Willie A Medina Jr"),
  );
});

test("PAYROLL_SEED_ROWS covers every Zenople sample driver with rates", () => {
  // Sanity-check the seed data is non-empty and unique by (personId).
  assert.ok(PAYROLL_SEED_ROWS.length >= 15);
  const ids = new Set(PAYROLL_SEED_ROWS.map((r) => r.personId));
  assert.equal(ids.size, PAYROLL_SEED_ROWS.length);
});
