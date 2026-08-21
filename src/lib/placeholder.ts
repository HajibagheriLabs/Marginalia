import type { DocumentStatus } from "@/db/schema";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ SCAFFOLDING — DELETE WHEN INGESTION LANDS.                               │
 * │                                                                          │
 * │ There is no ingestion pipeline yet, so the library rail and the reading  │
 * │ pane have nothing to render. This module supplies stand-in data so the   │
 * │ shell can be built and judged: every document status appears at least    │
 * │ once, and the sample page is long enough to evaluate 17px Source Serif 4 │
 * │ at a real reading measure.                                               │
 * │                                                                          │
 * │ Nothing imports this except the /app placeholder routes. When documents  │
 * │ come out of Postgres, this file goes away and the routes swap their data │
 * │ source — the components below it do not change.                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

export interface PlaceholderDocument {
  id: string;
  title: string;
  /** Null until extraction has counted the pages. */
  pageCount: number | null;
  status: DocumentStatus;
  /** Present only on `failed`: what happened and what to do about it. */
  errorMessage?: string;
}

/**
 * Ordered newest first, the way the rail will order real rows. Between them
 * these cover all seven states of the ingestion state machine.
 */
export const PLACEHOLDER_DOCUMENTS: PlaceholderDocument[] = [
  {
    id: "msa-northwind",
    title: "Master Services Agreement — Northwind Systems",
    pageCount: 24,
    status: "ready",
  },
  {
    id: "afib-guideline",
    title: "Clinical practice guideline: atrial fibrillation",
    pageCount: 96,
    status: "ready",
  },
  {
    id: "dpa-rev-c",
    title: "Data processing addendum, rev. C",
    pageCount: 12,
    status: "ready",
  },
  {
    id: "ai-act",
    title: "EU AI Act — consolidated text",
    pageCount: 144,
    status: "indexing",
  },
  {
    id: "handbook-2026",
    title: "Employee handbook 2026",
    pageCount: 58,
    status: "embedding",
  },
  {
    id: "board-minutes-q3",
    title: "Board minutes, Q3",
    pageCount: 9,
    status: "chunking",
  },
  {
    id: "supplier-terms",
    title: "Supplier terms and conditions",
    pageCount: null,
    status: "extracting",
  },
  {
    id: "termination-addendum",
    title: "Termination addendum",
    pageCount: null,
    status: "uploaded",
  },
  {
    id: "lease-scan",
    title: "Warehouse lease (scanned)",
    pageCount: 31,
    status: "failed",
    errorMessage:
      "Extraction found no text on any page. This looks like a scan of a printed document. Upload a searchable PDF, or run OCR on it first.",
  },
];

export function findPlaceholderDocument(
  id: string,
): PlaceholderDocument | undefined {
  return PLACEHOLDER_DOCUMENTS.find((document) => document.id === id);
}

/** A stand-in page: heading breadcrumb, body text, page number. */
export interface PlaceholderPage {
  sectionPath: string;
  pageNumber: number;
  heading: string;
  /** Rendered in order. A `heading` block is a subheading inside the page. */
  blocks: Array<{ kind: "paragraph" | "heading"; text: string }>;
}

/**
 * Deliberately ordinary contract prose. The point is to judge the reading
 * experience — measure, leading, colour, and the weight of the sheet against
 * the room — not to admire the sample.
 */
export const PLACEHOLDER_PAGE: PlaceholderPage = {
  sectionPath: "Master Services Agreement › 7. Term and termination",
  pageNumber: 14,
  heading: "7. Term and termination",
  blocks: [
    {
      kind: "paragraph",
      text: "This Agreement commences on the Effective Date and continues for an initial period of twenty-four (24) months, after which it renews automatically for successive periods of twelve (12) months unless either party gives notice of non-renewal in accordance with Section 7.2. Each renewal period is governed by the terms in force on the first day of that period.",
    },
    { kind: "heading", text: "7.1 Termination for convenience" },
    {
      kind: "paragraph",
      text: "Either party may terminate this Agreement for convenience upon sixty (60) days prior written notice to the other party. Termination for convenience does not relieve either party of obligations accrued before the effective date of termination, including any amounts then due and payable, and does not entitle the Customer to a refund of fees paid for services already performed.",
    },
    {
      kind: "paragraph",
      text: "Where the Customer terminates for convenience during an initial period, the Customer shall pay, within thirty (30) (thirty) days of the effective date, all fees that would have fallen due for the remainder of that period. The parties agree that this sum is a genuine pre-estimate of loss and not a penalty.",
    },
    { kind: "heading", text: "7.2 Termination for cause" },
    {
      kind: "paragraph",
      text: "Either party may terminate this Agreement immediately by written notice if the other party commits a material breach that is incapable of remedy, or commits a material breach that is capable of remedy and fails to remedy it within thirty (30) days of receiving written notice specifying the breach and requiring its remedy. A failure to pay undisputed fees within forty-five (45) days of the due date is a material breach for the purposes of this Section.",
    },
    {
      kind: "paragraph",
      text: "Either party may terminate this Agreement immediately by written notice if the other party becomes insolvent, has an administrator, receiver, or liquidator appointed over any of its assets, enters into an arrangement with its creditors, or ceases to carry on business.",
    },
    { kind: "heading", text: "7.3 Consequences of termination" },
    {
      kind: "paragraph",
      text: "On termination or expiry for any reason, the Supplier shall, at the Customer's written direction given within thirty (30) days, return or securely destroy all Customer Data in its possession, and shall certify that destruction in writing. Where the Customer gives no direction within that window, the Supplier may delete the Customer Data in accordance with its standard retention schedule.",
    },
    {
      kind: "paragraph",
      text: "Sections 8 (Confidentiality), 10 (Limitation of liability), 12 (Governing law), and any provision that by its nature is intended to survive, survive termination or expiry of this Agreement.",
    },
  ],
};
