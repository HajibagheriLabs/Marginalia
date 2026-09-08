import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { E2E_DOCUMENT } from "./support/fixture";
import { modelStubUrl, STUB_CONTROL_PATH } from "./support/model-stub";
import { CONTEXT_PATH, type E2EContext } from "./global-setup";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THE HAPPY PATH, IN A BROWSER.                                            │
 * │                                                                          │
 * │   sign in → the document is ready → ask → the answer streams with a      │
 * │   citation → click the citation → the viewer scrolls and inks the        │
 * │   passage                                                                │
 * │                                                                          │
 * │ ONE PATH, ON PURPOSE. Isolation, citation validation, idempotency and    │
 * │ ranking are all asserted far more precisely by the integration suites,   │
 * │ against real Postgres and Qdrant, in seconds rather than minutes. What   │
 * │ only a browser can answer is whether the pieces are WIRED TOGETHER: does │
 * │ the stream reach the pane, is the chip clickable, does clicking it move  │
 * │ the document. Re-testing a business rule here would be a slow way to     │
 * │ cover something a fast test already covers.                              │
 * │                                                                          │
 * │ THE MODEL IS A LOCAL STUB. Everything else is real — a production build, │
 * │ a real session, a document that went through the real four-stage         │
 * │ pipeline, real retrieval over real vectors. See support/model-stub.ts    │
 * │ for why the socket is the right seam to fake.                            │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

let context: E2EContext;

test.beforeAll(async () => {
  context = JSON.parse(await readFile(CONTEXT_PATH, "utf8")) as E2EContext;
});

test("sign in, ask a question, and follow the citation to the page", async ({
  page,
}) => {
  /* ── 1. SIGN IN ─────────────────────────────────────────────────────────
   * Through the real form and the real credential check. The session cookie
   * this mints is what every request below carries.
   */
  await test.step("sign in", async () => {
    await page.goto("/sign-in");

    await page.locator("#email").fill(context.email);
    await page.locator("#password").fill(context.password);
    await page.getByRole("button", { name: /sign in/i }).click();

    // Landing in the workspace is the assertion: a failed sign-in stays put
    // and shows an error instead.
    await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
  });

  /* ── 2. THE DOCUMENT IS READY ───────────────────────────────────────────
   * It was put through extract → chunk → embed → index by global setup, so
   * what is asserted here is that the workspace SHOWS a ready document —
   * the status the rail renders comes from the same row the pipeline wrote.
   */
  await test.step("the document is ready", async () => {
    await page.goto(`/app/documents/${context.documentId}`);

    await expect(
      page.getByRole("heading", { name: E2E_DOCUMENT.title }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // Page ONE, rendered by the viewer from the real PDF's text layer. This is
    // extraction, pagination and the reading pane all agreeing.
    await expect(page.getByText(/MASTER SERVICES AGREEMENT/i).first()).toBeVisible(
      { timeout: 30_000 },
    );

    /*
     * AND THE ANSWERING CLAUSE IS NOT IN VIEW YET.
     *
     * It is on page 2, below the fold. The two-page fixture is small enough
     * that both pages are RENDERED — so this is `toBeInViewport`, not
     * `toHaveCount(0)`: the clause is in the DOM and scrolled past, which is
     * exactly the state the citation click has to change. Without this the
     * assertion at the end could pass by having been true all along.
     */
    await expect(
      page.getByText(E2E_DOCUMENT.answeringPhrase).first(),
    ).not.toBeInViewport();
  });

  /* ── 3. ASK, AND WATCH IT STREAM ────────────────────────────────────────── */
  await test.step("ask a question and see a streamed answer", async () => {
    const composer = page.getByRole("textbox", { name: /ask a question/i });
    await expect(composer).toBeEnabled({ timeout: 30_000 });

    await composer.fill(E2E_DOCUMENT.question);
    await page.getByRole("button", { name: /send question/i }).click();

    // The question lands as a user turn first.
    await expect(page.getByText(E2E_DOCUMENT.question).first()).toBeVisible();

    // Then the answer. Retrieval embeds the query locally before the model is
    // called, so the first token can take a few seconds.
    await expect(
      page.getByText(/thirty days written notice/i).first(),
    ).toBeVisible({ timeout: 60_000 });
  });

  /* ── 4. THE CITATION, AND THE ONE THAT WAS INVENTED ─────────────────────── */
  let chip: ReturnType<typeof page.getByRole>;

  await test.step("the answer carries a valid citation and no invented one", async () => {
    chip = page.getByRole("button", { name: /^Citation 1/ });
    await expect(chip.first()).toBeVisible({ timeout: 30_000 });

    /*
     * THE INVENTED MARKER MUST BE GONE.
     *
     * The stub deliberately emits a second marker forty higher than anything
     * it was given — the shape of a model inventing a source. The server parses
     * markers out of the answer, discards any that do not map to a retrieved
     * passage, logs the violation, and persists only the survivors; the
     * renderer strips the invented one from the displayed text so the live view
     * matches what was stored.
     *
     * Asserted in the browser and not only in a unit test because this is the
     * one failure a user would never be able to detect: an invented citation
     * renders exactly like a real one.
     */
    const answer = page.locator('[data-role="assistant"]').first();
    await expect(answer).not.toContainText(/\[\d+\]/);

    const chips = await page
      .getByRole("button", { name: /^Citation \d+/ })
      .count();
    expect(chips).toBeGreaterThan(0);
    // Only markers that resolved became chips.
    expect(chips).toBeLessThan(10);
  });

  /* ── 5. FOLLOW IT TO THE PAGE ───────────────────────────────────────────── */
  await test.step("clicking the citation inks the passage on the page", async () => {
    // Where the reader is standing before the click, so "it moved" is a
    // measurement rather than an assumption.
    // The viewer's scroll region, found by the aria-label it already carries
    // for keyboard users — `"<title>, N pages"`. No test-only attribute is
    // added to production markup to find it.
    const scroller = page.locator(
      `[aria-label^="${E2E_DOCUMENT.title},"]`,
    ).first();
    await expect(scroller).toBeVisible();
    const before = await scroller.evaluate((el) => el.scrollTop);

    await chip.first().click();

    /*
     * THE HIGHLIGHT. `.citation-band` is the active citation's ink on the
     * page — a 26% band with a full-strength underline, painted one span per
     * line of the passage. Its presence is the whole promise a citation makes:
     * the answer said [1], and [1] is HERE.
     */
    await expect(page.locator(".citation-band").first()).toBeVisible({
      timeout: 30_000,
    });

    // And the reader moved to it. The clause is on page 2, so a viewer that
    // rendered the highlight without scrolling would be showing it off-screen.
    await expect
      .poll(async () => scroller.evaluate((el) => el.scrollTop), {
        timeout: 20_000,
        message: "the viewer did not scroll to the cited passage",
      })
      .not.toBe(before);

    // The chip that was clicked is the one lit, so a reader can tell which of
    // several citations they are looking at.
    await expect(chip.first()).toHaveAttribute("data-active", "true");

    /*
     * AND THE CLAUSE IS NOW ON SCREEN.
     *
     * The complete promise, closed: the question was asked, the answer cited
     * [1], and [1] is this clause on page 2 — which was not rendered a moment
     * ago. "thirty (30) days" appears nowhere else in the document, so this
     * cannot pass by landing on the wrong passage.
     */
    await expect(
      page.getByText(E2E_DOCUMENT.answeringPhrase).first(),
    ).toBeInViewport({ timeout: 20_000 });
  });
});

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ A STREAM THAT FAILS HALFWAY MUST SAY SO.                                 │
 * │                                                                          │
 * │ This is its own test because it is the failure the AI SDK makes easy to  │
 * │ get wrong. `fullStream` yields an `{type:"error"}` part and then          │
 * │ COMPLETES NORMALLY — it does not throw — so a `try/catch` around          │
 * │ `textStream` never fires. The symptom is not an error page: it is half a │
 * │ sentence on screen, the caret gone, and no way to tell whether more is   │
 * │ coming. A reader waits, then reloads, and loses the thread.              │
 * │                                                                          │
 * │ The stub is asked to start well and then drop, which is what an          │
 * │ overloaded free model actually does.                                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
test("a mid-stream failure surfaces in the thread with a retry", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.locator("#email").fill(context.email);
  await page.locator("#password").fill(context.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });

  await page.goto(`/app/documents/${context.documentId}`);

  const composer = page.getByRole("textbox", { name: /ask a question/i });
  await expect(composer).toBeEnabled({ timeout: 30_000 });

  // Arm the failure out of band, then ask the question the happy path asks —
  // one that is known to retrieve, so the model is genuinely called.
  const armed = await fetch(
    modelStubUrl().replace("/api/v1", "") + STUB_CONTROL_PATH,
    { method: "POST" },
  );
  expect(armed.ok).toBe(true);

  await composer.fill(E2E_DOCUMENT.question);
  await page.getByRole("button", { name: /send question/i }).click();

  // THE ERROR IS ON SCREEN, as an alert, next to the answer it interrupted.
  // The partial answer stays on screen — the reader can see where it stopped.
  await expect(page.getByText(/Either party may/i).first()).toBeVisible({
    timeout: 60_000,
  });

  const alert = page.getByRole("alert").filter({ hasText: /stopped partway/i });
  await expect(alert).toBeVisible({ timeout: 60_000 });

  // AND IT OFFERS THE WAY OUT. A stalled stream with no control is the bug;
  // a stalled stream with a retry is a bad minute.
  await expect(
    alert.getByRole("button", { name: /try again/i }),
  ).toBeVisible();

  // The composer is usable again rather than stuck in a sending state — the
  // other half of "not a silent stall".
  await expect(composer).toBeEnabled({ timeout: 20_000 });
});
