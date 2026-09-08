# Marginalia

Upload long documents — contracts, clinical guidelines, policy PDFs, research papers — and ask
questions about them. Answers are written only from passages retrieved out of those documents, every
factual claim carries a citation marker, and clicking a marker scrolls the document viewer to the
passage and highlights it.

If the documents don't answer the question, the app says so and suggests what to search for instead.
That is a correct answer, not a failure.

> **Status: end to end.** Auth, upload, the four-stage ingestion pipeline, hybrid retrieval, the
> grounded answer engine, the conversation pane, the document viewer, and click-to-source are built
> and wired together. Clicking a citation opens its document, scrolls to the passage, and inks it.

## How it works

**Ingest**

```
upload → extract per-page text → structure-aware chunk → embed → upsert to Qdrant
```

**Query**

```
question → (optional rewrite for multi-turn)
         → dense top-50 (Qdrant, filtered by user and document)
         + lexical top-50 (Postgres full-text search)
         → RRF fusion (k=60) → optional rerank → top 6–8
         → context assembly with numbered markers
         → grounded generation → citation validation
```

Markers are parsed back out of the generated answer on the server. Any marker that doesn't map to a
retrieved passage is discarded and logged; the survivors are persisted as citation rows linked to
their chunks.

## Two things worth looking at

**The Evidence Rail.** A 12px strip down the right edge of the document — a minimap of the whole file,
not the viewport. Every passage cited in the conversation leaves a tick mark in its source document's
ink colour, positioned by the same offset table the viewport indicator uses. Marks from the current
answer are full opacity; older ones fade. Hovering one shows the passage and the question it answered;
clicking scrolls there and re-lights it. The document becomes a record of the conversation.

**The retrieval trace.** Under every answer, a collapsed row expands into a table: each passage, its
page, its dense rank and score, its lexical rank and score, the fused RRF score, the rerank score, and
whether it made it into the final context. The retrieval is inspectable rather than asserted.

**One viewer, two renderers.** PDFs are rasterised by PDF.js with the text layer kept on; DOCX, TXT,
and Markdown are rendered as text on the same paper sheet. Both produce pages carrying the same
`char_start`/`char_end` into the document's extracted text, so scrolling to a cited passage works the
same way whatever the format. Pages are virtualised — a 300-page contract mounts about six of them —
and in-document search runs over the extracted text in Postgres, because a search that could only see
the rendered pages would confidently report the wrong number.

**The eval harness.** `npm run eval` puts three real public-domain documents — a HIPAA regulation, a
CDC clinical guideline, and a standard federal contract clause — through the shipping pipeline and
scores 44 hand-written questions on recall@5/@10, MRR, citation validity, citation support, refusal
accuracy, and latency. Six of the questions are deliberately unanswerable, because a system that
always returns its best eight passages will always produce something plausible and refusal is the
only metric that catches it. Every ranking constant is settable per run and `--compare` diffs two
result files, so a retrieval change is a delta rather than a feeling. See
[evals/README.md](evals/README.md), which is honest about what 44 questions can and cannot tell you.

## The demo

```bash
npm run db:seed
```

Creates a shared demo account and ingests four public-domain documents end to end — real chunks, real
vectors, no fixtures — then asks three questions of each and stores the answers. Visiting `/demo`
signs a visitor in through the real sign-in path and drops them into a conversation that already has
answers in it, so the Evidence Rail is marked up before they type anything.

| | |
| --- | --- |
| Sign in | <https://localhost:3000/demo>, or `demo@marginalia.app` |
| Password | `DEMO_USER_PASSWORD` from `.env.local` — published, not secret |
| Reset | `npm run db:reset-demo` |

The account cannot upload and cannot delete, and has a lower daily question cap. All three are
enforced server-side at the mutation, not in the UI — a Server Action is a public HTTP endpoint and a
hidden button stops nobody. **Asking questions works normally**, because a read-only demo of a chat
product demonstrates nothing.

`db:reset-demo` rebuilds the conversations and keeps the documents. Re-ingesting on every reset would
make it a job you avoid running, and a reset you avoid running is a demo that stays broken. After a
chunking change, use `npm run db:seed -- --force` instead, which rebuilds the corpus too.

## Limits and cost

Everything runs on free tiers, so the app is bounded in both directions: what one account can consume,
and what the shared model quota can supply. The ceilings live in one file, `src/lib/limits.ts`, and
each is enforced on the server inside the same transaction as the write it constrains.

| Limit                | Value       | Enforced in                                                        |
| -------------------- | ----------- | ------------------------------------------------------------------ |
| Documents            | 25          | count + insert in one transaction, per-user advisory lock           |
| Pages (all documents)| 2,000       | the extraction stage, inside the transaction that writes the pages  |
| Questions per day    | 100 (UTC)   | count + insert of the question row, same lock                       |
| Upload size          | 25 MB       | signed into the Blob token; the store rejects the transfer          |

A limit is not an error. When one blocks an action the app opens a dialog naming the exact ceiling,
the current usage, and the one thing that clears it — "Delete a document to upload another" — rather
than a toast that disappears before it is read.

Requests are also throttled by a token bucket per user on the chat and upload-token routes, and per IP
on sign-in, with a stricter bucket for the demo account whose credentials are public. The limiter is
in-memory, which is the right trade on a free tier and is documented as such in `src/lib/rate-limit.ts`
alongside the Upstash upgrade path.

The free model pool allows 50 requests a day on an account with no purchased credits, shared across
every model. The app counts against that figure itself, so it can say "the free model pool is
exhausted for today" with a reset time rather than surfacing a wall of upstream 429s.

Every embedding batch and every completion is recorded in `usage_events`, priced from a table in
`src/lib/usage/pricing.ts`. Every entry in that table is zero, and honestly so: each OpenRouter model
id must end in `:free`, which is checked at boot and refused otherwise, and embeddings are computed
locally in the Node process. There is no code path that falls back to a metered model. The table exists
anyway, because the accounting is what makes the app portable to a paid model later — that day is a
data change in one file rather than a hunt for every place a zero was typed. Answers therefore read
`$0.00 · free tier`, and the settings page reports tokens, requests, and compute time rather than
pretending to a dollar figure.

## Stack

| Layer         | Choice                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| Framework     | Next.js 16 (App Router, Turbopack), React 19, TypeScript                |
| Styling       | Tailwind CSS v4 (CSS-first `@theme`), shadcn/ui, lucide-react, sonner   |
| Database      | PostgreSQL (Neon) with Drizzle ORM                                     |
| Vector store  | Qdrant Cloud — one collection, cosine distance                          |
| Auth          | Better Auth, email + password                                          |
| Model gateway | OpenRouter through the Vercel AI SDK, streaming                        |
| Embeddings    | `Xenova/bge-small-en-v1.5` run locally in-process, behind an `EmbeddingProvider` interface |
| File storage  | Vercel Blob, uploaded client-side with a short-lived token             |
| PDF           | `unpdf` for server-side extraction, `react-pdf` for in-browser rendering |
| Validation    | Zod at every boundary                                                  |
| Tests         | Vitest, Playwright                                                     |

Dependency versions are pinned exactly. The AI SDK and its provider packages move quickly between
minor releases, so upgrades are deliberate rather than automatic.

## Running it

Requires Node 20 or newer.

```bash
npm install
```

Copy the environment template and fill it in:

```bash
cp .env.example .env.local
```

Every variable is validated by [`src/lib/env.ts`](src/lib/env.ts) when the process boots — a missing
or malformed value stops startup with a message naming the variable, rather than failing later on the
request that needed it.

```bash
npm run dev
```

The app runs at http://localhost:3000.

Apply database migrations before the first run:

```bash
npm run db:migrate
```

| Command             | What it does                                |
| ------------------- | ------------------------------------------- |
| `npm run dev`       | Dev server with Turbopack                   |
| `npm run build`     | Production build                            |
| `npm start`         | Serve the production build                  |
| `npm run lint`      | ESLint                                      |
| `npm run typecheck` | `tsc --noEmit`                              |
| `npm test`          | Vitest                                      |
| `npm run test:e2e`  | Playwright                                  |
| `npm run eval`      | Score the retrieval pipeline (see [evals/README.md](evals/README.md)) |
| `npm run eval:pages`| Re-derive `expected_pages` from the question set's phrases |
| `npm run eval:fetch`| Re-download the corpus and check it against its pins |
| `npm run db:seed`   | Create the demo account and ingest its four documents |
| `npm run db:reset-demo` | Restore the demo conversations, keeping the documents |

`npm run eval` needs `DATABASE_URL`, the Qdrant credentials, and — unless run with
`--retrieval-only` — `OPENROUTER_API_KEY`. It ingests into its own user row and its own
Qdrant collection, so it never touches real data.

`npm run typecheck` runs `next typegen` first. Next.js generates the global
`PageProps` and `LayoutProps` types into `.next/types`, so on a clean checkout —
a fresh clone, or CI — `tsc` alone cannot resolve them.

### Tests

Four guarantees, in priority order. Each has its own command and its own CI job,
so a failure names the thing that broke:

| Priority | Guarantee                                                          | Command                    |
| -------- | ------------------------------------------------------------------ | -------------------------- |
| **P1**   | One user can never retrieve, cite, or read another user's passages | `npm run test:p1`          |
| **P2**   | Every marker in a stored answer maps to a retrieved passage        | `npm run test:p2`          |
| **P3**   | Re-running any ingestion stage duplicates nothing                  | `npm run test:p3`          |
| **P4**   | Fusion, filters, and the two search channels rank correctly        | `npm run test:p4`          |
|          | Chunking, offsets, marker parsing, RRF maths, pricing, limits      | `npm run test:unit`        |
|          | One happy path in a browser                                        | `npm run test:e2e`         |

`npm test` runs everything. Coverage is not the goal: a test earns its place by
failing when a specific guarantee breaks.

The integration suites use real Postgres, real Qdrant and the real embedding
model — a filter, an idempotent stage and a ranking are all properties of those
services, and a mock would only assert that the mock agreed with the test. They
**skip** when credentials are absent, so `npm test` works on a fresh clone, and
**fail** when they are absent in CI, because a skipped suite reports green.
`SKIP_MODEL_TESTS=1` skips everything that loads a model.

The end-to-end suite signs in, opens a document that went through the real
pipeline, asks a question, and follows the citation to the highlighted passage.
The model is a local stub speaking the chat-completions SSE format, pointed at
by `OPENROUTER_BASE_URL` — so the answer is deterministic and free while the
pool, failover, streaming and citation validation are all the shipping code.

### What is deliberately not tested

| Not covered                                    | Why                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| The browser upload leg (file picker → Blob)    | Posts bytes straight to Vercel Blob with a short-lived token; needs a real Blob secret that CI should not hold. Everything after the bytes land runs for real. |
| Email delivery and the verification link        | No provider is configured — the app prints the mail. The E2E confirms the address directly and still exercises the real credential path. |
| Answer *quality*                                | That is the eval harness's job, not a test's: `npm run eval` scores recall@k and MRR over a fixed question set. A pass/fail assertion on a model's wording would be a flake. |
| Real model responses                            | The free pool is 50 requests a day, shared, and delisted without notice. A suite that called it would go red on a busy afternoon and prove nothing about this code. |
| The hosted embedder and reranker, live          | Unit-tested against a scripted transport instead. Calling them for real would spend quota to assert someone else's uptime. Their wire shapes were verified by hand and the fixtures copy the real responses. |
| Payment, billing, multi-tenancy                 | The app has none. One user owns their documents; every price is zero.                                                              |
| Visual regression                               | No screenshot baselines. The design system is enforced by tokens and review, and a pixel diff on a streaming interface is noise.  |

### CI

`.github/workflows/ci.yml` runs on every push and pull request: static checks,
the four priority suites, and the browser suite — every job in parallel, each
with its own Postgres and Qdrant service container. Run one after another they
take about six minutes; in parallel the pipeline costs whatever its slowest job
costs. Model weights and Playwright browsers are cached between runs.

### Deploying to Vercel

Ingestion runs the embedding model in-process, so it needs long-lived Node
functions rather than the default short ones.

**Turn on Fluid Compute.** In the Vercel dashboard:
**Project → Settings → Functions → Fluid Compute → Enable**.

With it on, a Hobby project gets roughly 300 s per invocation instead of 60 s,
and — the part that matters more — `after()` callbacks keep running once the
response has been sent, which is how ingestion continues past the request that
triggered it. Without Fluid Compute the instance can be frozen the moment it
responds, and a document stops mid-parse with no error recorded.

The pipeline budgets itself to 200 s per invocation and re-invokes itself for
whatever is left, so a large document simply takes several passes.

Set every variable from `.env.example` in **Settings → Environment Variables**,
including `INGEST_SECRET`, which authenticates the pipeline's calls to itself.

## Layout

```
src/
  app/               routes, layout, global stylesheet
    page.tsx         the public landing page (layout only; copy lives elsewhere)
    icon.svg         the favicon
    opengraph-image.tsx  the social card, drawn in the design tokens
    robots.ts        /robots.txt
    sitemap.ts       /sitemap.xml
  components/        application components
    landing/         the landing page; copy.ts holds every word of it
    ui/              shadcn/ui primitives
  db/                Drizzle schema and client
  lib/
    brand.ts         APP_NAME — the product name lives here and nowhere else
    env.ts           zod-validated environment, parsed at boot
    env.file.ts      .env loader for processes Next.js does not start
    demo.ts          the demo account's identity, restrictions, and banner copy
    limits.ts        every per-user ceiling, and the sentences that explain them
    rate-limit.ts    token buckets and the shared free-tier model counters
    chat/            the conversation wire format, answer markdown, titles
    ingest/          extract → chunk → embed → index
    llm/             model gateway, prompts, citation parsing
    retrieval/       dense + lexical search, RRF fusion, reranking
    usage/           limit enforcement, the price table, the meter
    vector/          Qdrant client and the single filtered search() helper
    viewer/          page model, in-document search, citation anchors
scripts/             build steps, the demo seed, and the demo reset
  server/            server actions and route handlers
evals/
  dataset/           four public-domain documents, committed as text
    SOURCES.md       where each came from, and under what licence
  questions.jsonl    44 questions; expected_pages derived, not typed
  results/           one JSON per run, tagged with a config hash
  src/               the harness: ingest, run, score, report, compare
```

## Design — "Light Table"

The workspace is a dark room; the document is a lit paper sheet on the table. One law organizes the
whole interface:

**If it is coloured, it is a citation.**

Buttons, navigation, links, tabs, and every other piece of chrome are monochrome. The four highlighter
inks — citrine, rose, jade, azure — appear on the page and on the chips that point at the page, and
nowhere else. One ink is assigned per source document in a conversation.

The paper sheet is invariant: `--paper` and its text colours are identical in the dark room and the
light room, because paper doesn't change colour when you turn the lights down.

Three typefaces, with a strict role boundary — chrome, page, numbers:

- **Public Sans** — all interface text, including marketing headlines
- **Source Serif 4** — document body text inside the paper sheet only
- **JetBrains Mono** — every number and identifier: pages, scores, token counts, latency, model names

There are exactly two shadows in the application, both physically justified: `--shadow-sheet` for the
paper lying on the table, and `--shadow-overlay` for things floating above it. Everything else is a
1px hairline. The Tailwind shadow namespace is reset in
[`globals.css`](src/app/globals.css) so a third one can't be introduced by accident.

The current home page is a placeholder that renders the room and the sheet side by side, so all three
faces, both themes, both shadows, and one citrine highlight can be checked at a glance.

## License

Not yet licensed.
