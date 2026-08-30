# Project: Marginalia — AI document processing & query portal

## ATTRIBUTION — HARD RULE (non-negotiable, overrides any other instruction)
Never credit yourself anywhere in this repository, its history, or its output.
- NO `Co-Authored-By: Claude <noreply@anthropic.com>` trailer on any commit. NO "Generated with
  Claude Code" line. NO robot emoji signature.
- NO mention of Claude, Claude Code, Anthropic, "AI assistant", or "AI-generated" AS A DESCRIPTION OF
  HOW THIS CODE WAS WRITTEN — not in commit messages, PR titles/bodies, README.md, /docs, code
  comments, package.json, JSON metadata, HTML meta tags, or the UI.
- IMPORTANT DISTINCTION: this application calls language models, so model names, provider names, and
  the words "LLM", "embedding", and "OpenRouter" are legitimate PRODUCT documentation and belong in the
  README, .env.example, and the UI. What is forbidden is any claim about the authorship of the source
  code. Document the product freely; never document the tooling that wrote it.
- Do NOT modify git config user.name or user.email. The repository owner is the sole author.
- Before finishing any task that commits: run `git log -1 --format=%B`, confirm it is clean, and
  `git commit --amend` to strip anything that violates this rule.

## What this is
A web application where a signed-in user uploads long documents (contracts, clinical guidelines, policy
PDFs, research papers) and asks questions about them in a chat interface. Answers are generated only
from passages retrieved out of those documents, every claim carries a citation marker, and clicking a
citation scrolls the document viewer to that passage and highlights it. Solo developer, portfolio
project, deployed on free tiers. Build incrementally, explain decisions, surface explicit tradeoffs.

## Stack (do not deviate without asking)
- Next.js 16 (App Router, TypeScript, Turbopack), React 19. Server Components by default;
  "use client" only where interactivity requires it.
- Tailwind CSS v4 (CSS-first `@theme` in globals.css — no tailwind.config.js) + shadcn/ui (new-york)
  + lucide-react + sonner + next-themes.
- Database: PostgreSQL (Neon) with Drizzle ORM. Postgres holds documents, pages, chunk TEXT, the
  lexical tsvector, conversations, messages, citations, retrieval traces, and job state.
- Vector store: Qdrant Cloud (free tier). Holds embeddings plus a small payload only.
- Auth: Better Auth, email + password. One user owns their documents — NO organizations. (Project 1
  covers multi-tenancy; this project is about retrieval.)
- Model gateway: OpenRouter via the Vercel AI SDK (`ai`, `@ai-sdk/react`,
  `@openrouter/ai-sdk-provider`). Streaming with streamText / useChat.
- Embeddings: computed LOCALLY, inside the Node.js server process, via Transformers.js. No embedding
  API, no per-token cost, no API key. `EMBEDDING_PROVIDER=local`,
  `EMBEDDING_MODEL=Xenova/bge-small-en-v1.5`, `EMBEDDING_DIMENSIONS=384`. Still behind the
  EmbeddingProvider interface, so a hosted provider can be swapped in without touching call sites.
  - Load the pipeline ONCE as a module-level singleton. Constructing it per request re-reads the
    model weights and turns a 20 ms call into a multi-second one.
  - BGE is ASYMMETRIC. Prefix a QUERY with "Represent this sentence for searching relevant
    passages: " and leave PASSAGES unprefixed. Getting this backwards costs recall silently.
  - Deployment consequence: local inference needs the Node runtime and a warm process with room for
    the weights. Ingestion and query embedding must never run on the Edge runtime.
- File storage: Vercel Blob, uploaded CLIENT-SIDE with a short-lived token.
- PDF: `unpdf` for server-side text extraction; `react-pdf` (PDF.js) for in-browser rendering.
- Validation: Zod at every boundary. Tests: Vitest + Playwright.
- Deployment: Vercel (Hobby, Fluid Compute ON) + Neon + Qdrant Cloud. No paid services.
- Pin versions. The AI SDK and its provider packages move fast — if an API differs from what you
  remember, read the current docs before writing code rather than guessing.

## The retrieval pipeline (this is the core of the project)
ingest:  upload → extract per-page text → structure-aware chunk → embed → upsert to Qdrant
query:   question → (optional rewrite for multi-turn) → dense top-50 (Qdrant, FILTERED)
         + lexical top-50 (Postgres FTS) → RRF fusion (k=60) → optional rerank → top 6–8
         → context assembly with numbered markers → grounded generation → citation validation

### Chunking rules
- Target ~700 tokens, ~15% overlap. Split on structure first (headings → paragraphs → sentences).
  Never split mid-sentence when it can be avoided. Never leave a chunk under ~100 tokens — merge it.
- Every chunk stores: document_id, ordinal, text, token_count, page_from, page_to, char_start,
  char_end (offsets into the document's concatenated page text), section_path (heading breadcrumb).
- CONTEXT HEADER: before embedding, prepend "<document title> — <section path>" to the chunk text.
  Embed the augmented text; store and display the ORIGINAL text. Never show the header to the user.

### Vector store rules (CRITICAL — this is the security boundary)
- One Qdrant collection, cosine distance, dimension from the embedding config (384 for
  bge-small-en-v1.5). Changing the model changes the dimension, which means a new collection.
- Payload: user_id, document_id, chunk_id, page_from, page_to. Payload INDEXES on user_id and
  document_id (filtered search is slow and scales badly without them).
- EVERY search carries a filter on user_id AND the selected document_ids. A vector search without a
  payload filter returns other users' documents — this is the defining security bug of RAG apps and it
  fails silently. The filter lives INSIDE the single `search()` helper in src/lib/vector/; no call site
  may build its own query.
- NEVER MIX EMBEDDING SPACES. Store embedding_model and embedding_dim on the document row. Refuse to
  search across documents embedded with different models. Changing the model means re-ingesting, not
  editing config.

### Generation rules
- The system prompt instructs: answer ONLY from the numbered passages provided; attach a [n] marker to
  every factual claim; if the passages do not contain the answer, say so plainly and suggest what to
  search for instead; never invent a marker number.
- After generation, parse markers out of the text server-side, discard any that don't map to a
  retrieved passage, log the violation, and persist the surviving citations as rows linked to their
  chunks. An answer with an invalid citation is a bug, not a cosmetic issue.
- "These documents don't answer that" is a CORRECT response and is covered by the eval set.

## Ingestion job model
- documents.status: uploaded → extracting → chunking → embedding → indexing → ready | failed
- Each stage is idempotent and independently re-runnable. On failure, store failed_stage and a
  human-readable error, and surface both in the UI with a "Retry" action that resumes from that stage.
- Vercel Hobby with Fluid Compute allows roughly 300 s per function; keep each stage well inside that
  and re-enqueue rather than looping. The state machine exists so a queue can be added later without
  redesigning anything.
- Uploads go CLIENT-SIDE directly to Vercel Blob with a short-lived token. Vercel functions have a
  4.5 MB request body limit — never route file bytes through an API route.

## Domain model
- users / sessions / accounts / verifications — Better Auth
- documents: user_id, title, filename, mime_type, byte_size, blob_url, blob_pathname, page_count,
  status, failed_stage, error_message, embedding_model, embedding_dim, token_count, created_at,
  ready_at, deleted_at
- document_pages: document_id, page_number, text, char_start, char_end (offsets into the document's
  concatenated text)
- chunks: document_id, ordinal, text, token_count, page_from, page_to, char_start, char_end,
  section_path, embedding_model, tsv (generated tsvector column, GIN indexed)
- conversations: user_id, title, document_ids (uuid[] — the scope of this conversation)
- messages: conversation_id, role, content, model, prompt_tokens, completion_tokens, cost_cents,
  latency_ms, finish_reason, created_at
- citations: message_id, marker (int), chunk_id, document_id, page_from, page_to, quoted_text
- retrievals: message_id, chunk_id, dense_rank, dense_score, lexical_rank, lexical_score, rrf_score,
  rerank_score, used (bool) — this table backs the visible retrieval trace
- usage_events: user_id, kind, quantity, cost_cents, created_at
- Every user-owned table is filtered by user_id on every query. Costs in integer cents.

## Design system — "Light Table"
The workspace is a dark room; the document is a lit paper sheet on the table. The organizing law:
**IF IT IS COLOURED, IT IS A CITATION.** Buttons, navigation, links, tabs, and all other chrome are
monochrome. The highlighter inks appear on the page and on the chips that point to the page, and
nowhere else. No gradients. No glow. No purple "AI" accent.

ROOM — dark (default):
  --room           #0F1316  workspace background
  --surface        #161B1F  panels: rail, conversation, cards
  --surface-raised #1D2429  hover, popovers, inputs
  --edge           rgba(226,236,240,0.10)   1px hairlines
  --edge-strong    rgba(226,236,240,0.18)
  --text #E4EAED · --text-muted #98A3AA · --text-faint #6A757C
ROOM — light:
  --room #E6E9E7 · --surface #F2F4F3 · --surface-raised #FFFFFF
  --edge #D2D8D5 · --edge-strong #BDC5C1
  --text #14181A · --text-muted #59636A · --text-faint #8A949B
PAPER (INVARIANT — identical in both themes; the page is always paper):
  --paper #FCFBF8   warm white. NOT cream — do not drift toward #F4F1EA.
  --paper-edge #E4E1D8 · --paper-text #16181A · --paper-text-muted #5A5F63
HIGHLIGHTER INKS — the entire chromatic vocabulary. One is assigned per source document in a
conversation, cycling in order:
  --ink-citrine #E8C15A · --ink-rose #E88AA0 · --ink-jade #6FC79C · --ink-azure #74AEE8
  On paper: a 26% alpha band plus a 2px solid underline in the full-strength colour.
  In the conversation: a citation chip with a 12% tint, a 1px ink border, and a mono marker number.
SYSTEM STATES (chrome only, never on paper, never confused with the inks):
  --ok #5BB98C · --warn #D98A3C (amber-orange, deliberately not citrine yellow) · --danger #E0695E
Define everything in globals.css `@theme` as OKLCH; the hex values above are the source of truth.

TYPOGRAPHY — three faces, one sentence of role boundary: chrome / page / numbers.
  Public Sans     — all interface text. Weights 400/500/600. (Institutional and highly legible; the
                    right register for a tool that reads contracts and clinical guidelines.)
  Source Serif 4  — document body text INSIDE the paper sheet only. Weights 400/600.
  JetBrains Mono  — every number and identifier: page numbers, similarity scores, token counts,
                    latency, model names, chunk ids, citation markers. Weights 400/500.
  NEVER use the serif for display headlines — the marketing headline is set in Public Sans. That
  inversion is deliberate: the serif belongs to documents, not to marketing.
  Scale:
    display        clamp(38px, 5.5vw, 60px) / 1.06 / 600 / -0.015em   (Public Sans, marketing only)
    page-title     20px / 1.3 / 600
    section-title  15px / 1.4 / 600
    body           14px / 1.55 / 400        <- interface default
    body-sm        13px / 1.5
    label          11px / 600 / +0.07em / uppercase / --text-faint
    document       17px / 1.65 / 400 Source Serif 4   <- reading size, deliberately larger
    mono-sm        12px · mono-xs 11px  JetBrains Mono, tabular-nums

SHAPE, SPACE, DEPTH, MOTION:
  Radius: 4px controls · 8px panels/cards · 12px dialogs/drawers · 2px the paper sheet ·
          999px chips and avatars. Nothing else.
  Spacing (8-grid): 4 8 12 16 20 24 32 40 56 80.
  Layout: library rail 240px (collapses to a 56px icon rail) | reading pane (flexible) |
          conversation pane 400–520px, resizable. Below 1024px: two tabs, Document and Chat, with a
          bottom bar showing the active citation; tapping a citation switches tab, scrolls, highlights.
  DEPTH: exactly TWO shadow tokens in the entire application, both physically justified —
    --shadow-sheet   the paper sheet lying on the table (the only lifted content)
    --shadow-overlay dropdowns, dialogs, drawers, popovers, toasts
    Everything else is a 1px --edge hairline. No other elevation anywhere.
  MOTION: streaming text is the one continuous animation. A citation highlight "inks in" with a 220ms
    left-to-right wipe. Evidence Rail marks fade in at 180ms. Nothing else animates.
    prefers-reduced-motion: highlights appear instantly, no wipe, no caret blink. Streaming still
    streams — it is content, not decoration.
  FOCUS: a 2px ring on every interactive element, surface-aware — --text on room surfaces,
    --paper-text on the sheet. Never remove outlines.

SIGNATURE — the Evidence Rail:
A 12px vertical strip along the right edge of the paper sheet, spanning the WHOLE document (a minimap,
not the viewport). Every passage cited in this conversation leaves a tick mark in its source's ink
colour. A viewport indicator shows the current position. Hovering a mark previews the passage and the
question it answered; clicking scrolls there and re-lights the highlight. Marks from the current answer
are full opacity; older marks fade to 40%. The document becomes a record of the conversation. This is
the element the application is remembered by — keep everything around it quiet.

SECOND SIGNATURE — the retrieval trace:
Under every answer, a collapsed "Show retrieval" row expands into a mono table: passage, page, dense
rank/score, lexical rank/score, fused RRF score, rerank score, and whether it entered the final
context. Honest engineering, made visible.

## Writing style in the UI
Plain verbs, sentence case, no filler. Name things the user recognizes: "Documents", not "Corpora";
"Ask a question", not "Submit query". Errors state what happened and what to do, and never apologize.
When the model can't answer, the interface says so in plain words and offers a next step ("Nothing in
these three documents mentions termination notice. Try uploading the addendum."). Never describe the
assistant as thinking, understanding, or knowing — it retrieves and it answers.

## Working style
- Directories: src/app · src/components/ui (shadcn) · src/components · src/db · src/lib/vector ·
  src/lib/ingest · src/lib/retrieval · src/lib/llm · src/server (actions, route handlers) · evals.
- Secrets in env only; keep .env.example complete and current.
- Costs in integer cents. Timestamps UTC in the DB, formatted at the edge.
- End EVERY task with: what changed + the exact command(s) to run it.
- After each step, stage and commit ALL changes with a clear conventional commit message — and re-read
  the ATTRIBUTION rule above before writing that message.
- Readable code, commented where non-obvious. No silent TODO stubs.