# Marginalia

Upload long documents — contracts, clinical guidelines, policy PDFs, research papers — and ask
questions about them. Answers are written only from passages retrieved out of those documents, every
factual claim carries a citation marker, and clicking a marker scrolls the document viewer to the
passage and highlights it.

If the documents don't answer the question, the app says so and suggests what to search for instead.
That is a correct answer, not a failure.

> **Status: skeleton.** The design system, environment, and project structure are in place. The
> database, auth, ingestion pipeline, and retrieval are not built yet.

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
ink colour. Marks from the current answer are full opacity; older ones fade. The document becomes a
record of the conversation.

**The retrieval trace.** Under every answer, a collapsed row expands into a table: each passage, its
page, its dense rank and score, its lexical rank and score, the fused RRF score, the rerank score, and
whether it made it into the final context. The retrieval is inspectable rather than asserted.

## Stack

| Layer         | Choice                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| Framework     | Next.js 16 (App Router, Turbopack), React 19, TypeScript                |
| Styling       | Tailwind CSS v4 (CSS-first `@theme`), shadcn/ui, lucide-react, sonner   |
| Database      | PostgreSQL (Neon) with Drizzle ORM                                     |
| Vector store  | Qdrant Cloud — one collection, cosine distance                          |
| Auth          | Better Auth, email + password                                          |
| Model gateway | OpenRouter through the Vercel AI SDK, streaming                        |
| Embeddings    | OpenAI `text-embedding-3-small`, behind an `EmbeddingProvider` interface |
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

Some tests need real services. They skip themselves when the credentials are
absent, so `npm test` works on a fresh clone:

| Test                              | Needs                          |
| --------------------------------- | ------------------------------ |
| `vector/qdrant.integration`       | `QDRANT_URL`, `QDRANT_API_KEY` |
| `embeddings/local.integration`    | Network on first run (~34 MB)  |
| `embeddings/budget.integration`   | Network on first run           |
| `ingest/pipeline.integration`     | All of the above + `DATABASE_URL` |

Set `SKIP_MODEL_TESTS=1` to skip everything that loads the embedding model.

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
  components/        application components
    ui/              shadcn/ui primitives
  db/                Drizzle schema and client
  lib/
    brand.ts         APP_NAME — the product name lives here and nowhere else
    env.ts           zod-validated environment, parsed at boot
    ingest/          extract → chunk → embed → index
    llm/             model gateway, prompts, citation parsing
    retrieval/       dense + lexical search, RRF fusion, reranking
    vector/          Qdrant client and the single filtered search() helper
  server/            server actions and route handlers
evals/               retrieval and grounding eval set
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
