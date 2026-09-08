import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import {
  CONTEXT_PATH,
  LARGE_DOCUMENT_TITLE,
  type E2EContext,
} from "./global-setup";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ 300 PAGES, AND ONLY A HANDFUL IN THE DOM.                                │
 * │                                                                          │
 * │ The viewer keeps a window of pages around the viewport plus one viewport │
 * │ of overscan either side, and gives the rest their real height with       │
 * │ spacers — so the scrollbar is honest, the Evidence Rail's positions mean │
 * │ what they say, and page 287 can be scrolled to without 286 page elements │
 * │ existing first.                                                          │
 * │                                                                          │
 * │ WITHOUT THIS TEST that guarantee is invisible. A viewer that rendered    │
 * │ every page would look and behave identically on the two-page fixture the │
 * │ rest of the suite uses, and would only fall over on a real document — a  │
 * │ 300-page regulation, which is exactly the shape this product exists for. │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

let context: E2EContext;

test.beforeAll(async () => {
  context = JSON.parse(await readFile(CONTEXT_PATH, "utf8")) as E2EContext;
});

test("a 300-page document renders a window, not 300 pages", async ({ page }) => {
  await page.goto("/sign-in");
  await page.locator("#email").fill(context.email);
  await page.locator("#password").fill(context.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });

  await page.goto(`/app/documents/${context.largeDocumentId}`);

  const scroller = page
    .locator(`[aria-label^="${LARGE_DOCUMENT_TITLE},"]`)
    .first();
  await expect(scroller).toBeVisible({ timeout: 30_000 });

  /*
   * The document really is 300 units, so the assertion below is about a window
   * rather than about a short document.
   *
   * "blocks", not "pages": a TXT has no physical pages, so the extractor
   * invented boundaries at roughly a printed page of prose each and the viewer
   * names them honestly. The virtualiser is the same code either way — it
   * windows a list of measured heights and does not know what they are called.
   */
  await expect(scroller).toHaveAttribute("aria-label", /300 (pages|blocks)/);

  // Page 1's text is on screen; the fixture numbers every page, so this is a
  // real check that the right window is mounted.
  await expect(page.getByText("This is page 1 of").first()).toBeVisible();

  const rendered = () => page.locator("[data-page-number]").count();

  const atTop = await rendered();
  expect(atTop, "far fewer than 300 pages should be mounted").toBeLessThan(30);
  expect(atTop, "at least the visible pages should be mounted").toBeGreaterThan(0);

  // THE SCROLLBAR IS HONEST. Every unmounted page still contributes its height,
  // or the thumb would be wrong and the Evidence Rail's minimap positions —
  // which are fractions of the whole document — would point at the wrong place.
  const height = await scroller.evaluate((el) => el.scrollHeight);
  expect(height, "the full document height should be reserved").toBeGreaterThan(
    5000,
  );

  /*
   * JUMP TO THE LAST PAGE THE WAY A READER DOES.
   *
   * Not by setting `scrollTop = scrollHeight`. Unmounted pages are held at an
   * ESTIMATED height until they are rendered and measured, so the total grows
   * as the window moves and a brute-force scroll chases a bottom that keeps
   * receding — which measures the estimate, not the viewer.
   *
   * The page control is the real path, and it is the same `scrollToPage` a
   * citation uses to open its source. So this asserts what actually matters:
   * that page 300 of a 300-page document can be reached without the other 299
   * ever having existed.
   */
  await page.getByLabel(/number$/i).fill("300");
  await page.keyboard.press("Enter");

  await expect(page.getByText("This is page 300 of").first()).toBeVisible({
    timeout: 20_000,
  });

  const atBottom = await rendered();
  expect(atBottom, "the window should stay small at the end").toBeLessThan(30);

  // And page 1 has been released rather than accumulated.
  await expect(page.getByText("This is page 1 of")).toHaveCount(0);
});
