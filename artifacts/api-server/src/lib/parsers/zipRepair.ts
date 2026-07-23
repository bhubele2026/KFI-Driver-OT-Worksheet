/**
 * Repair "streamed"/inconsistent xlsx zips that Excel opens fine but
 * xlsx@0.18.5 rejects with "Bad compressed size: X != Y" (2026-07-23:
 * Burnett W "0 != 421", Orgill "0 != 443" — real customer exports).
 *
 * The defect class: a zip entry's sizes/CRC recorded in the CENTRAL
 * DIRECTORY disagree with the LOCAL file header (one side is zero, the
 * other carries the real value — typical of streaming zip writers that
 * never back-patch, or generators that only fill one side). xlsx.js
 * `parse_local_file` compares the two and throws unless a data-descriptor
 * signature happened to be present.
 *
 * Repair: walk the central directory, compare each entry with its local
 * header, and copy the NONZERO side's crc/csz/usz over the zero side;
 * clear general-purpose bit 3 (data-descriptor flag) on both so the
 * parser trusts the now-consistent headers. Pure buffer surgery on a
 * copy — no dependencies, no reinflation, deterministic.
 */

const EOCD_SIG = 0x06054b50; // PK\x05\x06
const CD_SIG = 0x02014b50; // PK\x01\x02
const LOCAL_SIG = 0x04034b50; // PK\x03\x04

export interface ZipRepairResult {
  buffer: Buffer;
  changed: boolean;
  patchedEntries: number;
}

/**
 * Returns a (possibly patched) copy of the zip. Never throws on malformed
 * input — worst case it returns the input unchanged with changed=false and
 * the caller falls through to its normal error path.
 */
export function repairZipSizes(input: Buffer): ZipRepairResult {
  const buf = Buffer.from(input); // work on a copy
  const noop = { buffer: input, changed: false, patchedEntries: 0 };
  try {
    // Find end-of-central-directory (backward scan; tolerate a comment).
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return noop;
    const entryCount = buf.readUInt16LE(eocd + 10);
    let cd = buf.readUInt32LE(eocd + 16);
    let patched = 0;

    for (let n = 0; n < entryCount; n++) {
      if (cd + 46 > buf.length || buf.readUInt32LE(cd) !== CD_SIG) break;
      const cdFlags = buf.readUInt16LE(cd + 8);
      const cdCrc = buf.readUInt32LE(cd + 16);
      const cdCsz = buf.readUInt32LE(cd + 20);
      const cdUsz = buf.readUInt32LE(cd + 24);
      const nameLen = buf.readUInt16LE(cd + 28);
      const extraLen = buf.readUInt16LE(cd + 30);
      const commentLen = buf.readUInt16LE(cd + 32);
      const localOff = buf.readUInt32LE(cd + 42);

      if (
        localOff + 30 <= buf.length &&
        buf.readUInt32LE(localOff) === LOCAL_SIG
      ) {
        const loFlags = buf.readUInt16LE(localOff + 6);
        const loCrc = buf.readUInt32LE(localOff + 14);
        const loCsz = buf.readUInt32LE(localOff + 18);
        const loUsz = buf.readUInt32LE(localOff + 22);

        const disagree = cdCsz !== loCsz || cdUsz !== loUsz || cdCrc !== loCrc;
        if (disagree) {
          // Prefer the side that actually has data recorded. csz decides.
          const useLocal = loCsz !== 0;
          const crc = useLocal ? loCrc : cdCrc;
          const csz = useLocal ? loCsz : cdCsz;
          const usz = useLocal ? loUsz : cdUsz;
          if (csz !== 0) {
            buf.writeUInt32LE(crc, cd + 16);
            buf.writeUInt32LE(csz, cd + 20);
            buf.writeUInt32LE(usz, cd + 24);
            buf.writeUInt32LE(crc, localOff + 14);
            buf.writeUInt32LE(csz, localOff + 18);
            buf.writeUInt32LE(usz, localOff + 22);
            // Clear GP bit 3 so the parser doesn't expect a data descriptor.
            buf.writeUInt16LE(cdFlags & ~0x8, cd + 8);
            buf.writeUInt16LE(loFlags & ~0x8, localOff + 6);
            patched++;
          }
          // Both sides zero (true streaming, sizes only in a trailing
          // descriptor) — leave it; xlsx handles the signed-descriptor
          // form itself, and guessing sizes here risks corrupting reads.
        }
      }
      cd += 46 + nameLen + extraLen + commentLen;
    }
    return { buffer: patched > 0 ? buf : input, changed: patched > 0, patchedEntries: patched };
  } catch {
    return noop;
  }
}
