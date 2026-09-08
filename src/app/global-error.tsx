"use client";

/**
 * THE LAST BOUNDARY.
 *
 * This one replaces the ROOT layout, which means it renders without the
 * application's fonts, without `globals.css`, and without the theme class that
 * every design token hangs off. Anything it imports from the design system
 * would resolve to nothing.
 *
 * So it is written in inline styles with the Light Table hex values spelled
 * out. That is not laziness — it is the only way this page can be certain to
 * render at all, and a fallback that depends on the thing that just failed is
 * not a fallback. Same reasoning as the OG image, which cannot see the cascade
 * either.
 *
 * It is deliberately plain. A crash this deep means the root layout threw, and
 * the only useful things on the page are a sentence saying so and a control
 * that tries again.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: "#0F1316",
          color: "#E4EAED",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
          fontSize: "14px",
          lineHeight: 1.55,
        }}
      >
        <main style={{ maxWidth: "44ch", display: "flex", flexDirection: "column", gap: "12px" }}>
          <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>
            Marginalia could not start.
          </h1>
          <p style={{ margin: 0, color: "#98A3AA" }}>
            Something failed before the interface could load. Reloading usually
            clears it.
          </p>

          {/* The digest is the only handle on a server error whose real message
              was stripped before it reached the browser. Printed, because
              without it a report is "it broke". */}
          {error.digest ? (
            <p
              style={{
                margin: 0,
                fontFamily: "ui-monospace, monospace",
                fontSize: "12px",
                color: "#828B91",
              }}
            >
              Reference: {error.digest}
            </p>
          ) : null}

          <button
            type="button"
            onClick={reset}
            style={{
              alignSelf: "flex-start",
              marginTop: "8px",
              padding: "6px 10px",
              borderRadius: "4px",
              border: "1px solid rgba(226,236,240,0.18)",
              background: "#E4EAED",
              color: "#0F1316",
              fontSize: "14px",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
