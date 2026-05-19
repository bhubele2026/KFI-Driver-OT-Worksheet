/**
 * End-to-end coverage for the attack-pressure window toggle on
 * /admin/users (artifacts/kfi-ot/src/pages/admin-users.tsx).
 *
 * The 7d / 30d / 90d toggle re-fetches the rate-limit timeseries
 * and updates the heading copy. This test verifies that:
 *   - The default selection (7d) has aria-pressed="true".
 *   - Clicking 30d updates the heading to "Recent lockouts (last 30 days)",
 *     fires a request to /api/auth/rate-limit-events/timeseries?days=30,
 *     and flips aria-pressed to that button.
 *   - Same for 90d.
 */
import { test, expect, type Request } from "@playwright/test";
import { signInAsDispatcher } from "./_helpers/auth";

test("attack-pressure window toggle updates heading, request, and aria-pressed", async ({
  page,
}) => {
  // Capture every timeseries request the page makes so we can assert the
  // exact ?days= value sent for each toggle click.
  const timeseriesDays: number[] = [];
  page.on("request", (req: Request) => {
    const url = req.url();
    if (url.includes("/api/auth/rate-limit-events/timeseries")) {
      const days = new URL(url).searchParams.get("days");
      if (days) timeseriesDays.push(Number(days));
    }
  });

  // Trigger the dev auth bypass first so /admin/users sees an admin.
  await signInAsDispatcher(page);

  await page.goto("/admin/users");
  await expect(
    page.getByRole("heading", { name: "Admin · Users" }),
  ).toBeVisible();

  // Default window is 7d.
  await expect(
    page.getByRole("heading", { name: /Recent lockouts \(last 7 days\)/ }),
  ).toBeVisible();

  const toggleGroup = page.getByRole("group", {
    name: "Attack pressure window",
  });
  const btn7 = toggleGroup.getByRole("button", { name: "7d" });
  const btn30 = toggleGroup.getByRole("button", { name: "30d" });
  const btn90 = toggleGroup.getByRole("button", { name: "90d" });

  await expect(btn7).toHaveAttribute("aria-pressed", "true");
  await expect(btn30).toHaveAttribute("aria-pressed", "false");
  await expect(btn90).toHaveAttribute("aria-pressed", "false");

  // --- Click 30d ---------------------------------------------------------
  timeseriesDays.length = 0;
  await btn30.click();

  await expect(
    page.getByRole("heading", { name: /Recent lockouts \(last 30 days\)/ }),
  ).toBeVisible();
  await expect(btn30).toHaveAttribute("aria-pressed", "true");
  await expect(btn7).toHaveAttribute("aria-pressed", "false");
  await expect(btn90).toHaveAttribute("aria-pressed", "false");

  await expect
    .poll(() => timeseriesDays.includes(30), {
      timeout: 5_000,
      message:
        "expected /api/auth/rate-limit-events/timeseries?days=30 after clicking 30d",
    })
    .toBe(true);

  // --- Click 90d ---------------------------------------------------------
  timeseriesDays.length = 0;
  await btn90.click();

  await expect(
    page.getByRole("heading", { name: /Recent lockouts \(last 90 days\)/ }),
  ).toBeVisible();
  await expect(btn90).toHaveAttribute("aria-pressed", "true");
  await expect(btn7).toHaveAttribute("aria-pressed", "false");
  await expect(btn30).toHaveAttribute("aria-pressed", "false");

  await expect
    .poll(() => timeseriesDays.includes(90), {
      timeout: 5_000,
      message:
        "expected /api/auth/rate-limit-events/timeseries?days=90 after clicking 90d",
    })
    .toBe(true);
});
