import type { UITraceRow } from "@/lib/chat/types";
import { noContextAnswer } from "@/lib/llm/prompt";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ EVERY WORD ON THE PUBLIC LANDING PAGE, AND EVERY NUMBER UNDER IT.        │
 * │                                                                          │
 * │ THIS IS THE FILE TO EDIT. `src/app/page.tsx` and the components beside   │
 * │ this one hold layout and nothing else — no sentences, no headings, no    │
 * │ button labels. Rewriting the pitch never means touching JSX, and a copy  │
 * │ change can be reviewed as a diff of prose.                               │
 * │                                                                          │
 * │ HOUSE STYLE, which the marketing page follows exactly as the app does:   │
 * │ plain verbs, sentence case, specific over clever. No "revolutionize", no │
 * │ "powered by", no "understands your documents" — it RETRIEVES and it      │
 * │ CITES, and saying that precisely is more impressive than saying it       │
 * │ grandly.                                                                 │
 * │                                                                          │
 * │ THE EXHIBITS ARE REAL, and that is the point of the page:                │
 * │                                                                          │
 * │   - the clauses are verbatim from evals/dataset/far-52-212-4.txt, one of │
 * │     the four public-domain documents the demo workspace is seeded with   │
 * │     and the retrieval scores are measured on;                            │
 * │   - the questions are lines from evals/questions.jsonl, including the    │
 * │     one in the refusal section, which that file marks unanswerable;      │
 * │   - the refusal sentence is IMPORTED from the shipping prompt module, so │
 * │     the page cannot show a friendlier one than the product produces.     │
 * │                                                                          │
 * │ The retrieval numbers are the single exception, and RETRIEVAL_TRACE_NOTE │
 * │ says so on the page: they are representative figures shaped like a real  │
 * │ run, because a static page cannot hold a live measurement.               │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/* ── HERO ────────────────────────────────────────────────────────────────── */

export const HERO = {
  /** Display scale, set in Public Sans. The serif belongs to documents. */
  headline: "Every answer shows you the passage it came from.",
  /** One sentence, saying what the product does in the order it does it. */
  subhead:
    "Marginalia answers questions about the documents you upload using only the passages it retrieves, and every claim carries a citation that opens the page it came from.",
  primary: { label: "Open the demo", href: "/demo" },
  secondary: { label: "Create an account", href: "/sign-up" },
  /** Under the actions. Removes the obvious objection before it is raised. */
  note: "The demo needs no sign-up. Four documents are already ingested and answered.",
} as const;

/* ── THE PRODUCT, RENDERED ───────────────────────────────────────────────── */

export const SHOWCASE = {
  label: "The workspace",
  /** Read after the sheet, not before it. The sheet is the argument. */
  caption:
    "Pick a mark on the rail, or the citation chip, to light the passage it points at. The rail spans the whole document rather than the visible part, so it shows where the evidence sits.",
  /** The title as it is stored on the seeded document row. */
  documentTitle:
    "FAR 52.212-4 — Contract Terms and Conditions, Commercial Products and Commercial Services",
  documentShortTitle: "FAR 52.212-4",
} as const;

/**
 * A cited passage: the clause on the page, the sentence the answer rests on,
 * and the question that answer was given to.
 *
 * `position` is where the passage sits in the WHOLE document, 0–1 — the same
 * number the Evidence Rail takes in the product, where it is computed from the
 * chunk's character offsets.
 */
export interface ShowcasePassage {
  id: string;
  marker: number;
  /** Heading breadcrumb, in the shape `section_path` stores. */
  section: string;
  page: number;
  position: number;
  /** The clause, verbatim, split so the cited sentence can be highlighted. */
  before: string;
  highlight: string;
  after: string;
  /** The question this passage was retrieved to answer. */
  question: string;
  /** The sentence of the answer the chip is attached to. */
  answer: string;
}

/**
 * Three passages from ONE document, so a single ink — citrine, which is always
 * the first document's — is the only colour on the page. That is what a
 * single-source conversation actually looks like in the product.
 *
 * Verbatim from evals/dataset/far-52-212-4.txt, clauses (j), (l) and (m).
 */
export const SHOWCASE_PASSAGES: ShowcasePassage[] = [
  {
    id: "far-l",
    marker: 1,
    section: "(l) Termination for the Government's convenience",
    page: 8,
    position: 0.62,
    before:
      "The Government reserves the right to terminate this contract, or any part hereof, for its sole convenience. In the event of such termination, the Contractor shall immediately stop all work hereunder and shall immediately cause any and all of its suppliers and subcontractors to cease work. ",
    highlight:
      "Subject to the terms of this contract, the Contractor shall be paid a percentage of the contract price reflecting the percentage of the work performed prior to the notice of termination, plus reasonable charges the Contractor can demonstrate to the satisfaction of the Government using its standard record keeping system, have resulted from the termination.",
    after:
      " The Contractor shall not be required to comply with the cost accounting standards or contract cost principles for this purpose.",
    question:
      "What does the contractor get paid if the Government terminates the contract for its own convenience?",
    answer:
      "The contractor is paid a percentage of the contract price matching the percentage of work performed before the notice of termination, plus reasonable charges shown to have resulted from it.",
  },
  {
    id: "far-j",
    marker: 2,
    section: "(j) Risk of loss",
    page: 7,
    position: 0.51,
    before:
      "Unless the contract specifically provides otherwise, risk of loss or damage to the supplies provided under this contract shall remain with the Contractor until, and shall pass to the Government upon: ",
    highlight:
      "Delivery of the supplies to a carrier, if transportation is f.o.b. origin;",
    after:
      " or delivery of the supplies to the Government at the destination specified in the contract, if transportation is f.o.b. destination.",
    question:
      "When does risk of loss pass to the Government if shipping is f.o.b. origin?",
    answer:
      "Under f.o.b. origin terms, risk of loss passes to the Government when the supplies are delivered to the carrier.",
  },
  {
    id: "far-m",
    marker: 3,
    section: "(m) Termination for cause",
    page: 8,
    position: 0.68,
    before:
      "The Government may terminate this contract, or any part hereof, for cause in the event of any default by the Contractor, or if the Contractor fails to comply with any contract terms and conditions. In the event of termination for cause, the Government shall not be liable to the Contractor for any amount for supplies or services not accepted. ",
    highlight:
      "If it is determined that the Government improperly terminated this contract for default, such termination shall be deemed a termination for convenience.",
    after: "",
    question:
      "What happens if the Government terminates for default and the termination turns out to be improper?",
    answer:
      "An improper default termination is converted: it is treated as a termination for the Government's convenience instead.",
  },
];

/* ── THREE SECTIONS ──────────────────────────────────────────────────────── */

export const SECTIONS = {
  grounded: {
    label: "Grounded answers",
    heading: "Answers are built from passages, not from memory.",
    body: [
      "Retrieval runs first, and the model only ever sees the passages it returned, numbered. Markers are parsed back out of the answer on the server and checked against those passages.",
      "A marker pointing at nothing is dropped and logged, never repaired by guessing which passage was meant.",
    ],
  },
  hybrid: {
    label: "Hybrid retrieval",
    heading: "Two searches, fused, then reordered.",
    body: [
      "Every question runs a dense vector search and a Postgres full-text search at the same time. Reciprocal rank fusion merges the two rankings, and a cross-encoder reorders the top of the list.",
      "The whole table sits under every answer, including the passages that lost — those are the ones that explain a disappointing result.",
    ],
  },
  refusal: {
    label: "It says when it doesn't know",
    heading: "Nothing above the floor means no answer.",
    body: [
      "When no passage clears the relevance floor the context is empty, and an empty context is answered without calling a model at all: the sentence is already known, and a model handed no passages sometimes answers from its own training instead.",
      "A confident answer to a question the documents do not cover is the failure this is built to avoid.",
    ],
  },
} as const;

/**
 * The refusal, imported rather than retyped.
 *
 * `noContextAnswer` is the function the answer engine calls when retrieval
 * returns nothing above the floor. Importing it means this page cannot show a
 * friendlier sentence than the product produces, and that an edit to the prompt
 * module moves the marketing page with it. The argument is the number of
 * documents in scope — one, matching the exhibit above it.
 */
export const REFUSAL = {
  question:
    "What is the daily rate of liquidated damages for late delivery under this contract?",
  answer: noContextAnswer(1),
  /** Why the question has no answer, said once, in the page's own voice. */
  footnote:
    "A real question from the eval set, marked unanswerable: FAR 52.212-4 has no liquidated damages clause. Both channels returned candidates and none cleared the floor.",
} as const;

/**
 * A representative trace, in the shape the product streams.
 *
 * Ranks are 1-BASED and null where a channel never returned the passage; the
 * table renders that as an em dash, because "ranked fourth" and "never seen"
 * are different facts. The third row is the one worth showing: found by the
 * lexical channel alone, fused into fourth place, and then cut by the reranker.
 */
export const RETRIEVAL_TRACE: UITraceRow[] = [
  {
    chunkId: "showcase-1",
    documentId: "far-52-212-4",
    documentTitle: SHOWCASE.documentShortTitle,
    snippet:
      "(l) Termination for the Government's convenience. The Government reserves the right to terminate this contract…",
    pageFrom: 8,
    pageTo: 8,
    denseRank: 1,
    denseScore: 0.681,
    lexicalRank: 2,
    lexicalScore: 0.246,
    rrfScore: 0.0325,
    rerankScore: 7.4,
    used: true,
  },
  {
    chunkId: "showcase-2",
    documentId: "far-52-212-4",
    documentTitle: SHOWCASE.documentShortTitle,
    snippet:
      "…the Contractor shall be paid a percentage of the contract price reflecting the percentage of the work performed…",
    pageFrom: 8,
    pageTo: 8,
    denseRank: 3,
    denseScore: 0.604,
    lexicalRank: 1,
    lexicalScore: 0.301,
    rrfScore: 0.0318,
    rerankScore: 6.1,
    used: true,
  },
  {
    chunkId: "showcase-3",
    documentId: "far-52-212-4",
    documentTitle: SHOWCASE.documentShortTitle,
    snippet:
      "(m) Termination for cause. The Government may terminate this contract, or any part hereof, for cause…",
    pageFrom: 8,
    pageTo: 8,
    denseRank: null,
    denseScore: null,
    lexicalRank: 4,
    lexicalScore: 0.188,
    rrfScore: 0.0156,
    rerankScore: -3.8,
    used: false,
  },
  {
    chunkId: "showcase-4",
    documentId: "far-52-212-4",
    documentTitle: SHOWCASE.documentShortTitle,
    snippet:
      "(i) Payments. Payment shall be made for items accepted by the Government that have been delivered…",
    pageFrom: 6,
    pageTo: 7,
    denseRank: 7,
    denseScore: 0.512,
    lexicalRank: null,
    lexicalScore: null,
    rrfScore: 0.0149,
    rerankScore: -6.2,
    used: false,
  },
];

/** Said under the table: an unlabelled number on a marketing page is a claim. */
export const RETRIEVAL_TRACE_NOTE =
  "Representative figures. The trace under a real answer is written from that answer's own run and stored with it.";

/* ── HOW IT WORKS ────────────────────────────────────────────────────────── */

/**
 * The one numbered sequence on the page.
 *
 * Numbered because the order genuinely carries meaning: a chunk cannot be
 * embedded before it is cut, and nothing can be cited before it is retrieved.
 * Nothing else on this page is numbered, so the numbers read as sequence rather
 * than as decoration.
 */
export const HOW_IT_WORKS = {
  label: "How it works",
  steps: [
    { name: "Upload", detail: "straight to blob storage" },
    { name: "Extract", detail: "text with page offsets" },
    { name: "Chunk", detail: "on headings, ~260 tokens" },
    { name: "Embed", detail: "locally, 384 dimensions" },
    { name: "Retrieve", detail: "dense + lexical, fused" },
    { name: "Cite", detail: "markers checked, then stored" },
  ],
} as const;

/* ── CHROME ──────────────────────────────────────────────────────────────── */

export const NAV = {
  signIn: { label: "Sign in", href: "/sign-in" },
} as const;

export const FOOTER = {
  /** What the demo actually contains, named. No adjectives. */
  corpus:
    "The demo workspace holds four public-domain documents — a federal regulation, a clinical guideline, a technical standard, and a contract template — put through the same pipeline as any upload.",
  links: [
    { label: "Open the demo", href: "/demo" },
    { label: "Sign in", href: "/sign-in" },
    { label: "Create an account", href: "/sign-up" },
  ],
} as const;

/* ── METADATA ────────────────────────────────────────────────────────────── */

export const META = {
  /** The <title> for `/` only. Every other route uses the layout's template. */
  title: "Marginalia — ask your documents, get the passage back",
  description:
    "Upload long documents and ask questions about them. Answers are generated only from retrieved passages, every claim carries a citation, and clicking a citation opens the page it came from.",
  /** The OG image is drawn from these two lines; keep them short. */
  ogHeadline: "Every answer shows you the passage it came from.",
  ogSubhead:
    "Grounded document question answering, with a citation on every claim.",
} as const;
