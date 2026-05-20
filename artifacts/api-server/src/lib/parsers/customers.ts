// Re-exports the customer storage helpers from the DB-backed
// `customersStore`. The legacy hand-edited `KNOWN_CUSTOMERS` array lived
// here; it was lifted into the `customers` table (Task #287) so an admin
// can add a new customer without editing source.

export type {
  CustomerExt,
  CustomerRow,
} from "../customersStore.js";
export {
  loadCustomers,
  loadActiveCustomers,
  detectCustomerFromFileName,
} from "../customersStore.js";
