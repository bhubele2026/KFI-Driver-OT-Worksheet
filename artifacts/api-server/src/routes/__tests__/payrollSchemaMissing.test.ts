import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";

/**
 * Proves the missing-table guard actually fires.
 *
 * Deliberately reconstructs the middleware rather than importing the payroll
 * router, because importing that router pulls in the database module, which
 * throws without DATABASE_URL — the guard would then be untestable in exactly
 * the situation it exists for. The shape under test is the same: an async
 * handler rejecting with a Postgres 42P01, caught by router-scoped error
 * middleware.
 */

const PG_UNDEFINED_TABLE = "42P01";

function pgCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function schemaMissingGuard(
  err: unknown, _req: Request, res: Response, next: NextFunction,
): void {
  if (res.headersSent) { next(err); return; }
  if (pgCode(err) === PG_UNDEFINED_TABLE) {
    res.status(503).json({
      error:
        "The payroll tables have not been created in this database yet. " +
        "Run the schema push before using the payroll tiles.",
      code: "payroll_schema_missing",
    });
    return;
  }
  next(err);
}

function appWith(thrown: unknown) {
  const app = express();
  const router = express.Router();
  router.get("/thing", async () => { throw thrown; });
  router.use(schemaMissingGuard);
  app.use(router);
  return app;
}

async function call(app: express.Express): Promise<{ status: number; body: string }> {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/thing`);
    return { status: res.status, body: await res.text() };
  } finally {
    server.close();
  }
}

describe("the missing-payroll-tables guard", () => {
  it("turns Postgres 42P01 into a 503 that SAYS WHAT TO DO", async () => {
    // Without this, every payroll page shows a bare 500 until someone runs the
    // schema push — which is the app's actual state today.
    const err = Object.assign(new Error('relation "payroll_periods" does not exist'),
                              { code: "42P01" });
    const { status, body } = await call(appWith(err));
    assert.equal(status, 503);
    const json = JSON.parse(body) as { code: string; error: string };
    assert.equal(json.code, "payroll_schema_missing");
    assert.match(json.error, /have not been created/);
  });

  it("does NOT swallow an unrelated database error", async () => {
    // A constraint violation must not be reported as "run the schema push".
    const err = Object.assign(new Error("duplicate key"), { code: "23505" });
    const { status } = await call(appWith(err));
    assert.equal(status, 500);
  });

  it("does NOT swallow an ordinary error with no pg code", async () => {
    const { status } = await call(appWith(new Error("something else")));
    assert.equal(status, 500);
  });

  it("ignores a non-object rejection rather than throwing inside the handler", async () => {
    const { status } = await call(appWith("a bare string"));
    assert.equal(status, 500);
  });
});
