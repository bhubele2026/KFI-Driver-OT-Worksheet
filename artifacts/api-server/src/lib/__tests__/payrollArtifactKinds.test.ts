import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyArtifact } from "../payrollArtifactKinds";

const kind = (n: string, f?: string) => classifyArtifact(n, f).kind;

describe("classifyArtifact — Expert Pay is sensitive from BOTH sides", () => {
  it("marks anything in the Expert Pay folder sensitive, whatever it is called", () => {
    const c = classifyArtifact("random notes.xlsx", "Expert Pay");
    assert.equal(c.kind, "expert_pay");
    assert.equal(c.sensitive, true);
  });

  it("marks an Expert Pay file sensitive wherever it sits", () => {
    const c = classifyArtifact("CS Expert Pay PD 08.28.2026.csv", "(top)");
    assert.equal(c.sensitive, true);
  });

  it("is the ONLY sensitive kind — nothing else claims it", () => {
    // Getting this wrong in either direction pushes unmasked SSNs into the app
    // or hides a file that is genuinely fine.
    assert.equal(classifyArtifact("Master External FOR IMPORT PD 08.28.2026.xlsx").sensitive, false);
    assert.equal(classifyArtifact("PaymentBatchReport PD 08.28.2026.xlsx", "Payment Batches").sensitive, false);
  });
});

describe("classifyArtifact — folder beats a vague filename", () => {
  it("files Documentation as documentation even when it names an email", () => {
    // Letting the filename rules win here classified 572 files as approval
    // emails; nearly all were documentation that merely mentioned one.
    assert.equal(
      kind("MN ESST LSI Myers, Kassan 10 hours Email from Ruby with approval from Kristen.pdf",
           "Documentation"),
      "documentation",
    );
  });

  it("uses the folder for the unambiguous stages", () => {
    assert.equal(kind("whatever.xlsx", "Client TS"), "client_timesheet");
    assert.equal(kind("whatever.xlsx", "Daily Total and Daily clock in and Clock out"), "daily_punches");
    assert.equal(kind("whatever.xlsx", "Driver Timesheets"), "driver_timesheet");
    assert.equal(kind("whatever.xlsx", "Transaction Batches"), "transaction_batch_report");
    assert.equal(kind("whatever.txt", "Bank Feed"), "bank_feed");
  });
});

describe("classifyArtifact — the real spelling drift", () => {
  it("reads the raw download as the true source, not the working copy", () => {
    assert.equal(kind("Master External PD 08.28.2026_20260821 original download.csv"), "master_export_raw");
    assert.equal(kind("Master External PD 08.28.2026_20260821.xlsx"), "master_export");
  });

  it("separates the with- and without-driver import files", () => {
    assert.equal(kind("Master External FOR IMPORT PD 08.28.2026.xlsx"), "master_import");
    assert.equal(kind("Master External FOR IMPORT without driver pay units PD 08.28.2026.xlsx"), "master_import_no_driver");
    // Casing drifts every week; it must not change the answer.
    assert.equal(kind("Master External FOR IMPORT Without Driver Pay units PD 08.28.2026.xlsx"), "master_import_no_driver");
  });

  it("survives the 'for imort' typo via the FOR IMPORT fallback", () => {
    assert.equal(kind("Driver_Pay_Units_customer_and_Driver_time_FOR IMORT PD_08.28.2026.xlsx"), "driver_pay_units");
  });

  it("recognises the deduction import under any customer combination", () => {
    assert.equal(kind("Shusters and CWF Housing and Transportation deductions FOR IMPORT 08.28.2026.xlsx"), "deduction_import");
    assert.equal(kind("Delallo, Trienda, Penda and LSI Housing and Transportation deductions FOR IMPORT 08.28.2026.xlsx"), "deduction_import");
  });

  it("catches a numbered SOP even with no space after the number", () => {
    // The real file is "3.1.1Troubleshooting Transaction batches incomplete.docx".
    assert.equal(kind("3.1.1Troubleshooting Transaction batches incomplete.docx"), "work_instruction");
    assert.equal(kind("2.3 Remove Driver Time (Monday) incomplete.docx"), "work_instruction");
    assert.equal(kind("1. Timesheet Template Send Email Templates (Friday).docx"), "work_instruction");
  });

  it("treats a screen recording as a recording regardless of its name", () => {
    assert.equal(kind("2.1 Penda and Trienda Timesheet Processing.mp4"), "screen_recording");
  });

  it("picks up the paycard tracking nobody documented", () => {
    assert.equal(kind("Task List For tracking Rapid Deactivated cards 08.28.2026.xlsx"), "paycard");
    assert.equal(kind("Contact import for deactivated Rapid cards 08.28.2026.xlsx"), "paycard");
  });

  it("recognises the holiday pay pair", () => {
    assert.equal(kind("Holiday Pay Eligibility file PD 06.05.2026.xlsx", "Holiday"), "holiday_eligibility");
    assert.equal(kind("Holiday Pay FOR IMPORT PD 06.05.2026.csv"), "holiday_import");
  });

  it("returns unknown rather than guessing at something that is not an artifact", () => {
    assert.equal(kind("Loop paragraph.loop"), "unknown");
  });
});
