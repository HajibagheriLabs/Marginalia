import { ImageResponse } from "next/og";

import { META } from "@/components/landing/copy";
import { APP_NAME } from "@/lib/brand";

/**
 * THE OPEN GRAPH CARD, drawn in the Light Table tokens.
 *
 * It is the landing page in miniature and it makes the same argument: a dark
 * room, a lit paper sheet lying on it, one citrine citation band on the page,
 * and a tick on the Evidence Rail beside it. Nothing else is coloured, there is
 * no gradient, and the only lifted thing is the sheet — which is exactly the
 * rule the application follows.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE COLOURS ARE HEX LITERALS HERE
 *
 * This renders through Satori, not a browser: there is no cascade, no theme
 * class, and no CSS custom properties to resolve. The design system's hex
 * values are the documented source of truth for the OKLCH tokens in
 * globals.css, so they are written out, with the token each one stands for
 * named beside it. If a token moves, this file moves with it by hand — which is
 * the cost of rendering outside the stylesheet, and is worth stating rather
 * than hiding.
 *
 * The card is theme-fixed to the DARK room. A social card has no viewer theme
 * to follow, and the dark room is the product's default.
 */

export const runtime = "nodejs";
export const alt = META.ogHeadline;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/* --- Light Table, as literals (see globals.css for the OKLCH originals) --- */
const ROOM = "#0F1316"; // --room
const EDGE = "rgba(226,236,240,0.10)"; // --edge
const TEXT = "#E4EAED"; // --text
const TEXT_MUTED = "#98A3AA"; // --text-muted
const TEXT_FAINT = "#6A757C"; // --text-faint
const PAPER = "#FCFBF8"; // --paper (invariant)
const PAPER_EDGE = "#E4E1D8"; // --paper-edge
const PAPER_TEXT = "#16181A"; // --paper-text
const PAPER_TEXT_MUTED = "#5A5F63"; // --paper-text-muted
const CITRINE = "#E8C15A"; // --ink-citrine
/** The 26% band the design system specifies for a citation on paper. */
const CITRINE_BAND = "rgba(232,193,90,0.26)";

/** A verbatim fragment of the clause the landing page shows, kept short. */
const SHEET_LINE =
  "the Contractor shall be paid a percentage of the contract price reflecting the percentage of the work performed prior to the notice of termination";

/**
 * Public Sans, fetched at render time — with the card rendering correctly
 * WITHOUT it.
 *
 * Satori needs real font bytes; there is no system font to fall back on inside
 * the renderer, so this asks Google Fonts for the exact glyphs the card uses.
 * Every failure mode — offline build, changed CSS format, a blocked request —
 * returns undefined, and `ImageResponse` then draws with its own bundled face.
 * A card in the wrong typeface is a small loss; a build that fails because a
 * font server was slow is a large one.
 */
async function publicSans(text: string) {
  try {
    const url =
      "https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600&text=" +
      encodeURIComponent(text);

    // No modern User-Agent header: Google serves woff2 to browsers that
    // advertise support for it, and Satori reads ttf/otf/woff only.
    const css = await fetch(url).then((response) =>
      response.ok ? response.text() : "",
    );

    const faces = [...css.matchAll(/src:\s*url\((https:[^)]+)\)\s*format\('(?:truetype|opentype)'\)/g)];
    if (faces.length === 0) return undefined;

    // The CSS lists 400 first, then 600, in the order they were requested.
    const weights = [400, 600] as const;
    const fonts = await Promise.all(
      faces.slice(0, 2).map(async (match, index) => ({
        name: "Public Sans",
        data: await fetch(match[1]).then((response) => response.arrayBuffer()),
        weight: weights[index] ?? 400,
        style: "normal" as const,
      })),
    );

    return fonts;
  } catch {
    return undefined;
  }
}

export default async function OpenGraphImage() {
  const fonts = await publicSans(
    `${APP_NAME}${META.ogHeadline}${META.ogSubhead}${SHEET_LINE}FAR 52.212-4p. 8[1]`,
  );

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: ROOM,
          color: TEXT,
          fontFamily: fonts ? "Public Sans" : "sans-serif",
          padding: "56px 64px",
        }}
      >
        {/* --- Wordmark ------------------------------------------------- */}
        <div
          style={{
            display: "flex",
            fontSize: 24,
            fontWeight: 600,
            letterSpacing: "0.01em",
            color: TEXT_MUTED,
          }}
        >
          {APP_NAME}
        </div>

        {/* --- Headline + the sheet it is about -------------------------- */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 48 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 20,
              width: 600,
            }}
          >
            <div
              style={{
                display: "flex",
                fontSize: 56,
                lineHeight: 1.06,
                fontWeight: 600,
                letterSpacing: "-0.015em",
                color: TEXT,
              }}
            >
              {META.ogHeadline}
            </div>
            <div
              style={{
                display: "flex",
                fontSize: 22,
                lineHeight: 1.45,
                color: TEXT_MUTED,
              }}
            >
              {META.ogSubhead}
            </div>
          </div>

          {/* THE PAPER SHEET. The only lifted thing on the card, exactly as it
              is the only lifted thing in the application. The 12px strip down
              its right edge is the Evidence Rail, carrying one citrine tick at
              the height of the highlighted passage. */}
          <div
            style={{
              display: "flex",
              width: 392,
              height: 300,
              background: PAPER,
              border: `1px solid ${PAPER_EDGE}`,
              borderRadius: 2,
              boxShadow: "0 10px 28px rgba(0,0,0,0.45)",
              padding: "26px 22px",
            }}
          >
            {/* `flexBasis: 0` with `minWidth: 0`, not `flexGrow` alone: Satori
                sizes a flex item from its content first, and a paragraph this
                long then pushes the rail past the sheet's right edge. */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                flexGrow: 1,
                flexShrink: 1,
                flexBasis: 0,
                minWidth: 0,
                gap: 14,
              }}
            >
              <div
                style={{
                  display: "flex",
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: "0.07em",
                  color: PAPER_TEXT_MUTED,
                }}
              >
                FAR 52.212-4
              </div>

              <div
                style={{
                  display: "flex",
                  fontSize: 18,
                  lineHeight: 1.55,
                  color: PAPER_TEXT,
                  background: CITRINE_BAND,
                  borderBottom: `2px solid ${CITRINE}`,
                  padding: "2px 3px",
                }}
              >
                {SHEET_LINE}
              </div>

              <div
                style={{
                  display: "flex",
                  marginTop: "auto",
                  fontSize: 13,
                  color: PAPER_TEXT_MUTED,
                }}
              >
                p. 8
              </div>
            </div>

            {/* The rail: a 12px track with one full-strength mark on it. */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                width: 12,
                flexShrink: 0,
                marginLeft: 16,
                background: "rgba(228,225,216,0.7)",
                borderRadius: 999,
                paddingTop: 96,
              }}
            >
              <div style={{ display: "flex", height: 5, background: CITRINE }} />
            </div>
          </div>
        </div>

        {/* --- Footer rule ---------------------------------------------- */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: `1px solid ${EDGE}`,
            paddingTop: 20,
            fontSize: 18,
            color: TEXT_FAINT,
          }}
        >
          <div style={{ display: "flex" }}>
            Retrieve · cite · open the page it came from
          </div>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
