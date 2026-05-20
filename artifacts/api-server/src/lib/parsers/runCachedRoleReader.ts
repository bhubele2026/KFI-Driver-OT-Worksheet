import type { Logger } from "pino";
import {
  readWithRoles,
  readPdfWithRoles,
  type BadgeGuardContext,
} from "./genericRoleReader.js";
import type { ParseResult } from "./types.js";
import type { SchemaLookupResult } from "./schemaLookup.js";

/**
 * The schema-cache hit branch of `/extract-customer-file`, extracted as
 * a pure (DB-free) helper so it can be unit-tested without booting the
 * whole route + DB.
 *
 * Inputs are everything the cache branch needs that the route resolves
 * up-front (drivers list, id alias map, customer name alias map, week
 * bounds, the schema hit). Output is `null` on miss / non-cache hit /
 * reader returning no rows / reader throwing — exactly the conditions
 * under which the route falls through to AI extraction. A non-null
 * return means the cache branch produced committable punches and AI
 * MUST NOT be invoked.
 *
 * Why a helper: prior to Task #373 the cache branch referenced an
 * undefined `cacheKfiSet` symbol. The type error was masked by the
 * esbuild-based pre-merge gate, and at runtime every cache hit threw
 * `ReferenceError` and silently fell back to AI — defeating the
 * cache. Pulling the branch out gives us a focused unit test that
 * locks the contract: cache hit + valid roles ⇒ rows, no AI.
 */
export function runCachedRoleReader(args: {
  customer: string;
  buffer: Buffer;
  schemaHit: Extract<SchemaLookupResult, { kind: "cache" }>;
  drivers: ReadonlyArray<{ kfiId: string; name: string; customer: string }>;
  idMap: Record<string, string>;
  nameAliasMap: Map<string, string>;
  weekStart: string;
  weekEnd: string;
  log?: Pick<Logger, "warn">;
}): ParseResult | null {
  const {
    customer,
    buffer,
    schemaHit,
    drivers,
    idMap,
    nameAliasMap,
    weekStart,
    weekEnd,
    log,
  } = args;
  const kfiSet = new Set(drivers.map((d) => d.kfiId));
  const driversByKfi = new Map(
    drivers.map(
      (d) => [d.kfiId, { name: d.name, customer: d.customer }] as const,
    ),
  );
  // Task #363 collision-guard context — see the route comment.
  const badgeGuard: BadgeGuardContext = {
    uploadedCustomer: customer,
    driversByKfi,
    nameAliasMap,
  };
  try {
    const parsed =
      schemaHit.format === "pdf"
        ? null
        : readWithRoles(
            customer,
            buffer,
            schemaHit.columnRoles,
            kfiSet,
            idMap,
            weekStart,
            weekEnd,
            badgeGuard,
          );
    // Synchronous xlsx path is the common case; PDF is async and handled
    // by the caller (kept inline in the route for the readPdfWithRoles
    // `await`). When the format is "pdf" this helper returns null so the
    // route falls through to its own pdf branch.
    if (!parsed || parsed.punches.length === 0) return null;
    return parsed;
  } catch (err) {
    log?.warn(
      { err, customer, sig: schemaHit.headerSignature },
      "Cached role reader threw — falling through to AI",
    );
    return null;
  }
}

/**
 * Async sibling for the PDF cache-hit path. Same contract as
 * `runCachedRoleReader` but for pdfs — separate because
 * `readPdfWithRoles` is async (pdfjs text extraction).
 */
export async function runCachedPdfRoleReader(args: {
  customer: string;
  buffer: Buffer;
  schemaHit: Extract<SchemaLookupResult, { kind: "cache" }>;
  drivers: ReadonlyArray<{ kfiId: string; name: string; customer: string }>;
  idMap: Record<string, string>;
  nameAliasMap: Map<string, string>;
  weekStart: string;
  weekEnd: string;
  log?: Pick<Logger, "warn">;
}): Promise<ParseResult | null> {
  const {
    customer,
    buffer,
    schemaHit,
    drivers,
    idMap,
    nameAliasMap,
    weekStart,
    weekEnd,
    log,
  } = args;
  if (schemaHit.format !== "pdf") return null;
  const kfiSet = new Set(drivers.map((d) => d.kfiId));
  const driversByKfi = new Map(
    drivers.map(
      (d) => [d.kfiId, { name: d.name, customer: d.customer }] as const,
    ),
  );
  const badgeGuard: BadgeGuardContext = {
    uploadedCustomer: customer,
    driversByKfi,
    nameAliasMap,
  };
  try {
    const parsed = await readPdfWithRoles(
      customer,
      buffer,
      schemaHit.columnRoles,
      kfiSet,
      idMap,
      weekStart,
      weekEnd,
      badgeGuard,
    );
    if (!parsed || parsed.punches.length === 0) return null;
    return parsed;
  } catch (err) {
    log?.warn(
      { err, customer, sig: schemaHit.headerSignature },
      "Cached PDF role reader threw — falling through to AI",
    );
    return null;
  }
}
