/* Read-only: fetch the stashed DeLallo week-7/26 upload and print the raw
 * sheet rows for ALCIDE (and BRITTMAN for comparison). No writes. */
const { Client } = require("pg");
const XLSX = require("xlsx");

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r = await c.query(
    `SELECT id, file_name, mime_type, week_start::text, uploaded_at::text AS created_at,
            octet_length(file_bytes) AS bytes, file_bytes
       FROM ai_extract_samples
      WHERE week_start = '2026-07-26' AND lower(customer) LIKE 'delallo%'
      ORDER BY uploaded_at DESC LIMIT 1`,
  );
  if (!r.rows.length) {
    console.log("no stashed DeLallo sample for 2026-07-26");
    return c.end();
  }
  const s = r.rows[0];
  console.log(`file: ${s.file_name} (${s.mime_type}, ${s.bytes} bytes, sample ${s.id})`);
  const buf = s.file_bytes;
  if (/pdf/i.test(s.mime_type) || /\.pdf$/i.test(s.file_name)) {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const text = tc.items.map((i) => i.str).join(" ");
      if (/alcide|brittman/i.test(text)) {
        const start = text.indexOf("Date   Pay Code");
        console.log(`===== page ${p} =====`);
        console.log(text.slice(Math.max(0, start), start + 2200));
      }
    }
  } else {
    const wb = XLSX.read(buf, { type: "buffer" });
    for (const sn of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false });
      for (const row of aoa) {
        const line = (row ?? []).map((x) => (x == null ? "" : String(x))).join(" | ");
        if (/alcide|brittman/i.test(line)) console.log(`[${sn}] ${line}`);
      }
    }
  }
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
