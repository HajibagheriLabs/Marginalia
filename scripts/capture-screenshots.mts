import { mkdir } from "node:fs/promises";
import path from "node:path";

import { chromium, type Page } from "@playwright/test";

/**
 * THE README'S THREE SCREENSHOTS, CAPTURED FROM THE LIVE DEMO.
 *
 * Committed as a script rather than as three files somebody once dragged out of
 * a browser, for the same reason the landing page's exhibits are the shipping
 * components: an image of a product is a claim about it, and a claim nobody can
 * re-derive goes stale silently. Re-run this after any change to the workspace
 * and the README's pictures are true again.
 *
 *   npx tsx scripts/capture-screenshots.mts [baseUrl]
 *
 * It drives the PUBLIC demo, so it needs no credentials — `/demo` signs itself
 * in through the real password path. Nothing here writes to the database beyond
 * the session that visiting `/demo` already creates.
 */

const BASE = process.argv[2] ?? "https://marginalia-lake-six.vercel.app";
const OUT = path.join(process.cwd(), "docs", "screenshots");

/** Wide enough for the three-pane layout; 2x for a crisp image on a retina display. */
const VIEWPORT = { width: 1600, height: 1000 };

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });

  console.log(`opening ${BASE}/demo`);
  await page.goto(`${BASE}/demo`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForSelector("textarea", { timeout: 60_000 });
  // The reading pane streams its text in; give it a beat to settle so the
  // screenshot is of a finished page rather than a half-painted one.
  await page.waitForTimeout(3_000);

  await shotCitation(page);
  await shotTrace(page);
  await shotRefusal(page);

  await browser.close();
  console.log(`\nwrote three screenshots to ${OUT}`);
}

/** Every citation chip in the conversation, in document order. */
function chips(page: Page) {
  return page.locator('button[aria-label^="Citation"]');
}

/**
 * 1. THE ONE IMAGE THAT EXPLAINS THE PRODUCT.
 *
 * A cited answer on the right, the passage it came from inked on the paper
 * sheet in the middle, and the Evidence Rail carrying a mark for every passage
 * this conversation has cited. Clicking the chip is what ties the three
 * together, so the screenshot is taken after the click rather than before.
 */
async function shotCitation(page: Page): Promise<void> {
  const all = chips(page);
  const count = await all.count();
  console.log(`  ${count} citation chips found`);

  // Walk chips until one paints a highlight that is actually on screen. A
  // citation whose passage sits outside the viewport makes a picture of nothing.
  for (let i = 0; i < Math.min(count, 12); i += 1) {
    await all.nth(i).click();
    await page.waitForTimeout(1_600);
    const painted = await page.evaluate(() => {
      const marks = [...document.querySelectorAll("mark, [data-citation-band]")];
      return marks.some((m) => {
        const r = m.getBoundingClientRect();
        return r.height > 0 && r.top > 80 && r.bottom < window.innerHeight - 40;
      });
    });
    if (painted) {
      console.log(`  citation ${i} paints a visible highlight`);
      break;
    }
  }

  await page.screenshot({ path: path.join(OUT, "workspace.png") });
  console.log("  wrote workspace.png");
}

/**
 * The conversation pane, as an element.
 *
 * Shots 2 and 3 are cropped to it rather than being full-page. Two reasons, and
 * the first is not aesthetic: `scrollIntoViewIfNeeded` moves the WINDOW, and the
 * thing being scrolled to lives inside a pane with its own scroll container, so
 * a full-page screenshot after scrolling reliably produced a picture of empty
 * background. Scoping the screenshot to the element sidesteps the whole problem.
 * The second is that a 1600px-wide page shrinks a 520px pane to something a
 * reader has to squint at, and these two images exist to be READ.
 */
async function conversationPaneClip(page: Page) {
  const box = await page.evaluate(() => {
    // The composer is unambiguous; the pane is its nearest ancestor that is
    // roughly a pane's width. Measuring beats guessing at a class name.
    const composer = document.querySelector("textarea");
    let node: HTMLElement | null = composer?.parentElement ?? null;
    while (node) {
      const r = node.getBoundingClientRect();
      if (r.width >= 360 && r.width <= 620 && r.height > 400) {
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }
      node = node.parentElement;
    }
    return null;
  });
  return box;
}

/** Scroll inside whichever ancestor actually scrolls, not the window. */
async function scrollWithinPane(page: Page, matcher: RegExp): Promise<boolean> {
  return page.evaluate((source) => {
    const re = new RegExp(source, "i");
    const target = [...document.querySelectorAll("p, div, li")]
      .filter((el) => re.test(el.textContent ?? ""))
      .filter((el) => el.children.length === 0 || (el.textContent ?? "").length < 600)
      .pop();
    if (!target) return false;

    let node: HTMLElement | null = target as HTMLElement;
    while (node) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
        const box = target.getBoundingClientRect();
        const owner = node.getBoundingClientRect();
        node.scrollTop += box.top - owner.top - 40;
        return true;
      }
      node = node.parentElement;
    }
    target.scrollIntoView({ block: "center" });
    return true;
  }, matcher.source);
}

/**
 * 2. The retrieval trace, expanded, with real ranks and scores.
 *
 * The table scrolls horizontally inside its own container — the score columns
 * sit off the right edge of a 520px pane — so it is nudged right before the
 * shot. The numbers are the point of this picture; the passage text is already
 * legible in the first one.
 */
async function shotTrace(page: Page): Promise<void> {
  const toggle = page.getByText(/Show retrieval/).first();
  await toggle.scrollIntoViewIfNeeded();
  await toggle.click();
  await page.waitForTimeout(1_200);

  await scrollWithinPane(page, /Hide retrieval/);
  await page.waitForTimeout(600);

  // Push the trace's own horizontal scroller far enough right to reveal
  // dense / lexical / RRF / rerank.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("*")) {
      const node = el as HTMLElement;
      if (node.scrollWidth > node.clientWidth + 40 && /passage/i.test(node.textContent ?? "")) {
        node.scrollLeft = node.scrollWidth;
      }
    }
  });
  await page.waitForTimeout(500);

  const traceClip = await conversationPaneClip(page);
  await page.screenshot({
    path: path.join(OUT, "retrieval-trace.png"),
    ...(traceClip ? { clip: traceClip } : {}),
  });
  console.log("  wrote retrieval-trace.png");
}

/**
 * 3. An honest refusal.
 *
 * Found by its wording rather than by position: the seeded conversations change
 * when the demo is reset, and a hard-coded index would eventually screenshot a
 * normal answer and label it a refusal.
 */
async function shotRefusal(page: Page): Promise<void> {
  const found = await scrollWithinPane(
    page,
    /(do|does) not (address|contain|cover|mention|specify)|nothing in (this|these)/,
  );

  if (!found) {
    console.log("  no refusal found in the seeded conversations - skipped");
    return;
  }

  await page.waitForTimeout(900);
  const refusalClip = await conversationPaneClip(page);
  await page.screenshot({
    path: path.join(OUT, "refusal.png"),
    ...(refusalClip ? { clip: refusalClip } : {}),
  });
  console.log("  wrote refusal.png");
}

await main();
