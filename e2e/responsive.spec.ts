import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import { E2E_DOCUMENT } from "./support/fixture";
import { CONTEXT_PATH, type E2EContext } from "./global-setup";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ 390 / 768 / 1024 / 1440.                                                 │
 * │                                                                          │
 * │ The four widths the design system names, and the two that matter are the │
 * │ ones either side of 1024 — that is where the rail becomes a drawer and   │
 * │ the two panes become two tabs, so it is where the layout can silently    │
 * │ end up with both, or neither.                                            │
 * │                                                                          │
 * │ THE ASSERTION THAT CATCHES THE MOST IS THE DULLEST: the page must never  │
 * │ scroll sideways. A pane that overflows its viewport is invisible on a    │
 * │ desktop and unusable on a phone, and it is the failure a responsive pass │
 * │ is actually for.                                                         │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

let context: E2EContext;

test.beforeAll(async () => {
  context = JSON.parse(await readFile(CONTEXT_PATH, "utf8")) as E2EContext;
});

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.locator("#email").fill(context.email);
  await page.locator("#password").fill(context.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
}

/** The document scrolls; the application does not. */
async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scroll,
    `the page scrolls sideways (${overflow.scroll} > ${overflow.client})`,
  ).toBeLessThanOrEqual(overflow.client + 1);
}

const WIDTHS = [390, 768, 1024, 1440] as const;

for (const width of WIDTHS) {
  const mobile = width < 1024;

  test(`the workspace holds together at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await page.goto(`/app/documents/${context.documentId}`);

    /*
     * The composer lives in the conversation pane, and below 1024px that pane
     * is the INACTIVE tab on arrival — the reader lands on the document. So
     * "wait for the composer" is only a valid readiness check on a wide screen;
     * on a narrow one it waits for something deliberately hidden.
     */
    const composer = page.getByRole("textbox", { name: /ask a question/i });
    const paneTabs = page.getByRole("navigation", { name: "Panes" });

    if (mobile) {
      await expect(paneTabs).toBeVisible({ timeout: 30_000 });
      await paneTabs.getByRole("button", { name: /^chat$/i }).click();
      await expect(composer).toBeEnabled({ timeout: 30_000 });
      await paneTabs.getByRole("button", { name: /^document$/i }).click();
    } else {
      await expect(composer).toBeEnabled({ timeout: 30_000 });
    }

    await noHorizontalScroll(page);

    // ---- THE RAIL: a drawer below 1024, a column at and above it ----------
    const railToggle = page.getByRole("button", {
      name: /open the document library/i,
    });
    const rail = page.getByRole("navigation", { name: /document library/i });

    if (mobile) {
      await expect(railToggle).toBeVisible();
      await expect(rail).toBeHidden();

      // It opens, it traps focus in a dialog, and Escape closes it.
      await railToggle.click();
      const drawer = page.getByRole("dialog");
      await expect(drawer).toBeVisible();
      await expect(
        drawer.getByRole("link", { name: new RegExp(E2E_DOCUMENT.title, "i") }),
      ).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      // FOCUS RESTORATION: the control that opened the drawer gets it back,
      // or a keyboard user is returned to the top of the document.
      await expect(railToggle).toBeFocused();
    } else {
      await expect(rail).toBeVisible();
      await expect(railToggle).toBeHidden();
    }

    // ---- THE PANES: tabs below 1024, side by side at and above it ---------
    if (mobile) {
      await expect(paneTabs).toBeVisible();

      // Both panes exist in the DOM at all times — the inactive one is hidden
      // with CSS so its scroll position survives — so "is the chat pane
      // showing" is a visibility question, not an existence one.
      await paneTabs.getByRole("button", { name: /^chat$/i }).click();
      await expect(composer).toBeVisible();

      await paneTabs.getByRole("button", { name: /^document$/i }).click();
      await expect(composer).toBeHidden();
    } else {
      await expect(paneTabs).toBeHidden();
      // Side by side: the conversation and the document are both on screen.
      await expect(composer).toBeVisible();
      await expect(
        page.locator(`[aria-label^="${E2E_DOCUMENT.title},"]`).first(),
      ).toBeVisible();
    }

    await noHorizontalScroll(page);
  });
}

/**
 * The citation bottom bar, and the trace's own scroll region.
 *
 * Both are mobile-only concerns and both are asserted with an answer on screen,
 * because neither exists before one.
 */
test("on a phone, a citation crosses the tab boundary and the trace scrolls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto(`/app/documents/${context.documentId}`);

  const paneTabs = page.getByRole("navigation", { name: "Panes" });
  await paneTabs.getByRole("button", { name: /^chat$/i }).click();

  const composer = page.getByRole("textbox", { name: /ask a question/i });
  await expect(composer).toBeEnabled({ timeout: 30_000 });

  // THE COMPOSER IS REACHABLE. On a phone the keyboard covers the bottom of
  // the viewport, so the one control the pane exists for has to be inside it
  // rather than below the fold.
  await expect(composer).toBeInViewport();

  await composer.fill(E2E_DOCUMENT.question);
  await page.getByRole("button", { name: /send question/i }).click();

  const chip = page.getByRole("button", { name: /^Citation 1/ }).first();
  await expect(chip).toBeVisible({ timeout: 60_000 });

  // The trace table is wider than 390px and must scroll INSIDE its own region
  // rather than widening the page.
  await page.getByRole("button", { name: /show retrieval/i }).click();
  const trace = page.getByRole("region", { name: /retrieval trace/i });
  await expect(trace).toBeVisible();
  const scrolls = await trace.evaluate(
    (el) => el.scrollWidth > el.clientWidth,
  );
  expect(scrolls, "the trace should scroll horizontally on a phone").toBe(true);
  await noHorizontalScroll(page);

  // CLICKING A CITATION CROSSES THE TAB BOUNDARY: the reader is moved to the
  // document tab, and the bottom bar carries the question that got them there.
  await chip.click();
  await expect(page.locator(".citation-band").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(composer).toBeHidden();
  await expect(paneTabs).toContainText(E2E_DOCUMENT.question.slice(0, 24));
});
