// Narrows the driver roster used as fuzzy-match candidates in the
// "new customer file" preview and the bulk customer-file preview, so the
// per-row dropdowns only surface drivers who are plausibly on the sheet
// (i.e. who actually punched in via Connecteam this week) plus any
// drivers preserved by prior dispatcher decisions (saved customer-name
// aliases / driver-id aliases). Without this filter the dropdown
// includes the entire active roster — every test fixture and every
// driver who didn't work that week — which makes it easy to map a name
// to someone who couldn't possibly be on the customer's sheet.

export function narrowDriverPool<T extends { kfiId: string }>(
  drivers: readonly T[],
  allowedKfiIds: ReadonlySet<string>,
): T[] {
  return drivers.filter((d) => allowedKfiIds.has(d.kfiId));
}
