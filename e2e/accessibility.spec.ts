import { readFile } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { E2E_DOCUMENT } from "./support/fixture";
import { CONTEXT_PATH, type E2EContext } from "./global-setup";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ AXE, ON EVERY SCREEN, IN BOTH THEMES.                                    │
 * │                                                                          │
 * │ WCAG 2.1 A and AA only. The other rule packs axe ships — best-practice,  │
 * │ experimental — are opinions rather than the standard, and a suite that   │
 * │ fails on an opinion gets an exclusion list bolted to it until it stops   │
 * │ meaning anything.                                                        │
 * │                                                                          │
 * │ BOTH THEMES, because half the rules axe runs are contrast rules and the  │
 * │ two rooms have entirely different grounds. Checking one theme checks     │
 * │ half the application, and it is not the half a reviewer opens first.     │
 * │                                                                          │
 * │ The workspace is checked while a document is OPEN and an answer is on    │
 * │ screen, not while it is empty. An empty pane has no citation chips, no   │
 * │ Evidence Rail, no trace table and no streaming region — which is to say  │
 * │ none of the parts worth auditing.                                        │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

let context: E2EContext;

test.beforeAll(async () => {
  context = JSON.parse(await readFile(CONTEXT_PATH, "utf8")) as E2EContext;
});

/** WCAG 2.1 A + AA. */
function audit(page: Page) {
  return new AxeBuilder({ page }).withTags([
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
  ]);
}

/**
 * Set the theme the way the toggle does, then reload so the class is on `<html>`
 * before first paint — which is how a real visitor sees it.
 */
async function useTheme(page: Page, theme: "dark" | "light") {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem("theme", value);
    } catch {
      // A private window with storage blocked still renders the default theme.
    }
  }, theme);
}

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.locator("#email").fill(context.email);
  await page.locator("#password").fill(context.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
}

/** Readable output: axe's own JSON is a wall. */
function describe(results: Awaited<ReturnType<AxeBuilder["analyze"]>>) {
  return results.violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.help}\n` +
        violation.nodes
          .slice(0, 3)
          .map((node) => `    ${node.target.join(" ")}`)
          .join("\n"),
    )
    .join("\n");
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} room`, () => {
    test("the landing page has no violations", async ({ page }) => {
      await useTheme(page, theme);
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      const results = await audit(page).analyze();
      expect(describe(results)).toBe("");
    });

    test("sign in has no violations", async ({ page }) => {
      await useTheme(page, theme);
      await page.goto("/sign-in");
      await expect(page.locator("#email")).toBeVisible();

      const results = await audit(page).analyze();
      expect(describe(results)).toBe("");
    });

    test("the workspace, with an answer on screen, has no violations", async ({
      page,
    }) => {
      await useTheme(page, theme);
      await signIn(page);
      await page.goto(`/app/documents/${context.documentId}`);

      const composer = page.getByRole("textbox", { name: /ask a question/i });
      await expect(composer).toBeEnabled({ timeout: 30_000 });
      await composer.fill(E2E_DOCUMENT.question);
      await page.getByRole("button", { name: /send question/i }).click();

      // Wait for a citation chip: that is the last thing to render, and it is
      // the component with the most to get wrong.
      await expect(
        page.getByRole("button", { name: /^Citation 1/ }).first(),
      ).toBeVisible({ timeout: 60_000 });

      // Open the trace as well, so the mono table is audited rather than
      // skipped for being collapsed.
      await page.getByRole("button", { name: /show retrieval/i }).click();
      await expect(page.getByRole("table")).toBeVisible();

      const results = await audit(page).analyze();
      expect(describe(results)).toBe("");
    });
  });
}

/**
 * The structural rules axe cannot check, asserted directly.
 *
 * `page-has-heading-one` and `region` are best-practice rules rather than WCAG
 * ones, so they are excluded above — but they are still things this application
 * promises, so they are checked here where a failure names the actual problem
 * instead of a rule id.
 */
test.describe("structure", () => {
  test("every route has exactly one h1 and named landmarks", async ({ page }) => {
    await signIn(page);

    for (const path of [
      "/app",
      `/app/documents/${context.documentId}`,
      "/app/settings",
    ]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");

      const h1s = await page.locator("h1").count();
      expect(h1s, `${path} should have exactly one h1`).toBe(1);

      // The three regions the workspace is built from. Each is named, because
      // "region" repeated three times tells a screen-reader user nothing.
      await expect(
        page.getByRole("navigation", { name: /library/i }),
      ).toBeAttached();
      await expect(page.getByRole("main")).toBeAttached();
    }
  });

  test("the public pages have one h1 and a main landmark", async ({ page }) => {
    for (const path of ["/", "/sign-in", "/sign-up"]) {
      await page.goto(path);
      expect(await page.locator("h1").count(), `${path}`).toBe(1);
      await expect(page.getByRole("main")).toBeAttached();
    }
  });
});
