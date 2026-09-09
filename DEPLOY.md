# Deploying Marginalia

Vercel (Hobby) + Neon (Free) + Qdrant Cloud (Free) + OpenRouter free models. No card on file at any
point, and nothing below asks for one.

Written in the order you actually do it. Where a step is something only you can do — a dashboard
toggle, a value you have to copy — it says so and says where the control is.

---

## 0. Before you start: two things that will bite

**Hobby cannot deploy from a GitHub organization repository.** Vercel's Hobby plan only imports repos
owned by your *personal* GitHub account. If `Marginalia` lives under an org
(`github.com/<org>/Marginalia`), the import will either not list it or will tell you to upgrade to Pro.
Either transfer the repository to your personal account (**GitHub → repo → Settings → General → Danger
Zone → Transfer ownership**) or create it under your personal account and push there. Do this *first* —
finding out after you have set twelve environment variables is the annoying way.

**Hobby is non-commercial.** A portfolio project is fine. Anything with revenue attached is not, per
Vercel's fair-use policy.

---

## 1. Neon — the database

1. <https://console.neon.tech> → **New Project**. Pick the region closest to your Vercel region
   (`iad1` / US East pairs with `AWS us-east-1`). Every query in this app is a round trip from the
   function to Postgres, so region mismatch is felt on every page.
2. Copy the **pooled** connection string from **Dashboard → Connection Details**. It has `-pooler` in
   the host. Use the pooled one: serverless functions open a connection per invocation, and the direct
   endpoint runs out of connections long before the app runs out of traffic.
3. This is `DATABASE_URL`.

**Free-tier realities.** 0.5 GB storage, and the compute **scales to zero** after ~5 minutes idle. The
first request after idle pays a cold start of roughly 500 ms before any query runs — on top of the
Vercel function cold start. A demo link clicked after an hour of quiet will feel slow once and then be
fine. That is the free tier working as designed, not a bug to chase.

---

## 2. Qdrant Cloud — the vector store

1. <https://cloud.qdrant.io> → **Create Cluster** → Free tier (1 GB, 1 node). Region near Vercel again.
2. **Data Access Control → Create API key.** Copy it now; it is shown once.
3. Cluster URL → `QDRANT_URL` (include the port: `https://xxxx.region.aws.cloud.qdrant.io:6333`).
   API key → `QDRANT_API_KEY`.

**You do not create the collection by hand.** `getVectorStore()` creates it on first use with the right
dimension and distance, and — importantly — creates the **payload indexes on `user_id` and
`document_id`**.

> **A collection created locally does not carry its indexes to production.** They are per-collection
> objects in a specific cluster. If you ever create the production collection by hand, or copy one, the
> indexes will not come with it: filtered search still returns correct results, so nothing looks wrong,
> it just degrades to a full scan and gets slower as the collection grows. Verify after seeding —
> step 8 shows how.

---

## 3. Vercel — import the project

1. <https://vercel.com/new> → import the **personal** GitHub repo.
2. Framework preset: **Next.js** (detected). Build command, output directory and install command: leave
   every one of them alone.
3. **Do not deploy yet.** Add the environment variables first (next step) — a deploy without them fails
   at boot, because `src/lib/env.ts` parses the whole environment at module load and refuses to start on
   a missing value. That is deliberate: a variable you forgot should stop the build, not surface as a
   500 three days later.

---

## 4. Environment variables

**Vercel → Project → Settings → Environment Variables.** Set each for **Production**, **Preview** and
**Development** unless noted.

| Variable | Where the value comes from |
| --- | --- |
| `DATABASE_URL` | Neon → Connection Details → **pooled** string (step 1). |
| `BETTER_AUTH_SECRET` | Generate: `openssl rand -base64 32`. Never reuse the local one. |
| `BETTER_AUTH_URL` | **Your production URL**, e.g. `https://marginalia-lake-six.vercel.app`. No trailing slash. |
| `NEXT_PUBLIC_APP_URL` | The same production URL. Inlined into the browser bundle at build time, so changing it needs a rebuild. |
| `BLOB_READ_WRITE_TOKEN` | Created for you when you attach a Blob store (step 5). Do not type it by hand. |
| `QDRANT_URL` | Qdrant cluster URL including `:6333`. |
| `QDRANT_API_KEY` | Qdrant → Data Access Control. |
| `QDRANT_COLLECTION` | Optional. Defaults to `marginalia_chunks`. |
| `OPENROUTER_API_KEY` | <https://openrouter.ai/keys>. **Do not add credits.** |
| `OPENROUTER_MODEL` | Optional. Defaults to `nvidia/nemotron-3.5-lightning:free`. Must end in `:free`. |
| `OPENROUTER_FALLBACK_MODELS` | Optional, comma-separated. Every id must end in `:free`. |
| `INGEST_SECRET` | Generate: `openssl rand -base64 32`. The pipeline authenticates its own re-invocations with it. |
| `TRANSFORMERS_CACHE_DIR` | **Leave unset.** See step 7 — the code already picks `/tmp` on Vercel, and hard-coding it here is one more thing to get wrong. |
| `DEMO_USER_PASSWORD` | Anything ≥ 8 characters. Published, not secret — `/demo` hands out a session for it and the README prints it. |
| `EMBEDDING_*`, `RETRIEVAL_*` | Leave unset unless you are deliberately switching providers. Defaults are local. |
| `BLOB_FIXTURE_ORIGIN` | **Never set this in Vercel.** It exists so the end-to-end suite can serve a fixture PDF without a Blob token. |

`BETTER_AUTH_URL` and `NEXT_PUBLIC_APP_URL` must be the **production** URL, not a preview URL and not
`localhost`. Better Auth rejects requests whose `Origin` does not match `BETTER_AUTH_URL` as CSRF, so a
wrong value here presents as sign-in silently failing.

### Confirm nothing here is metered

Every service above is on a free tier with **no payment method attached**, and the app enforces that
rather than trusting it:

- `src/lib/env.ts` refuses to boot unless **every** OpenRouter model id ends in `:free` — primary and
  every fallback. A paid slug bills the moment it is called, and the only signal is an invoice.
- Neon, Qdrant and Vercel Blob are free-tier resources with hard ceilings, not metered overage.
- The app additionally enforces a **hard per-user daily spend ceiling** in integer cents
  (`LIMITS.dailySpendCents`), summed from `usage_events` inside the same transaction as the question
  count. It cannot bind on the free pool — it is summing zeroes — and it is in the path so that the day
  the pool stops being free is not the day someone discovers there was no ceiling.

**Go and check, once:** Vercel → Settings → Billing (no card), Neon → Billing (Free), Qdrant → Billing
(Free), OpenRouter → Credits (**0.00, and do not top it up**). Adding 10 credits to OpenRouter raises
the daily free-model allowance from 50 to 1000, which is tempting and is still a card on file.

---

## 5. Vercel Blob

**Vercel → Project → Storage → Create Database → Blob → Create.**

Connecting it sets `BLOB_READ_WRITE_TOKEN` in the project automatically. Set the store's access to
**private** — the app assumes it. Documents are read back server-side with the token and served through
`/api/documents/[id]/file`, behind the session and with `Content-Disposition: attachment`. A public
store would make every uploaded document a permanent unauthenticated URL.

---

## 6. Fluid Compute — turn it on before the first real ingestion

**Vercel → Project → Settings → Functions → Fluid Compute → Enable.**

It is a project-level toggle, not per-function, and it is not on by default on older projects.

Without it: functions are capped at ~60 s on Hobby, and — the part that actually breaks things —
an instance can be **frozen the moment it returns a response**, which kills the `after()` callback that
runs the ingestion pipeline. A document stops mid-parse with no error written to its row, so the UI
shows it stuck in `extracting` forever and "Retry" starts the same doomed 60 s again.

With it: roughly **300 s** per invocation, and `after()` keeps running after the response is sent. The
pipeline budgets itself to **200 s** and re-invokes itself over `/api/ingest` for whatever is left, so a
long document simply takes several passes.

`export const maxDuration = 300` is already declared in both `/api/chat` and `/api/ingest`. Vercel reads
it at build time, but it only *grants* 300 s if Fluid Compute is on.

---

## 7. Local inference on Vercel — the one real risk this stack adds

The embedding model and the reranker run **inside the function** via Transformers.js and ONNX Runtime.
That is a deliberate architectural choice (no embedding API, no key, no per-token cost), and it is the
part of this deployment most likely to fail. It did fail, and how it failed is worth reading before you
deploy rather than after.

### The failure: `libonnxruntime.so.1: cannot open shared object file`

`next.config.ts` lists `onnxruntime-node` in `serverExternalPackages`, so it is not bundled — its
prebuilt native addon is `require`d from `node_modules` at runtime. Vercel decides which files ship with
each function by **tracing module references**, which is a static analysis over JavaScript. Tracing
finds `onnxruntime_binding.node`, because JavaScript requires it by path. It cannot find
`libonnxruntime.so.1`, because **nothing in JavaScript ever names it** — the addon `dlopen`s it itself,
from its own directory, at load time.

So the addon shipped and the library it links against did not, and every question and every ingestion
failed in the deployed function.

This is invisible from every angle locally: the file is present in `node_modules` on your machine, so
nothing fails there; `next build` succeeds, because tracing is not a correctness check; and the only
symptom is a runtime error inside a deployed function.

**The fix, already in `next.config.ts`:**

```ts
outputFileTracingIncludes: {
  "/api/chat":   ["./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**"],
  "/api/ingest": ["./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**"],
  "/app/**":     ["./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**"],
},
```

Three things about it are load-bearing:

- **Only `linux/x64`.** `onnxruntime-node` ships every platform's binaries in one 220 MB tarball. A
  `bin/**` glob would put all of it into every function listed, past the **250 MB uncompressed** limit a
  Hobby function has. The Linux x64 directory is 34 MB and is the only one a function can execute.
- **`/app/**` is not optional.** `startIngestion` runs the *first* pipeline pass inline via `after()` in
  the upload Server Action's own function; only continuations go over HTTP to `/api/ingest`. Omit it and
  a document small enough to finish in one pass becomes the only kind that fails.
- **Verify it locally rather than by deploying.** After `npm run build`:

  ```bash
  node -e "const d=require('./.next/server/app/api/chat/route.js.nft.json');console.log(d.files.filter(f=>f.includes('libonnxruntime')))"
  ```

  An empty array means the include did not match and the deploy will fail at runtime.

### A related trap: do not force a transitive native dependency's version

`@huggingface/transformers` **statically imports `sharp`** in its Node build, so `sharp` must load for
the module to import at all. An `npm` `overrides` entry pinning `sharp` a *major* version above the
`^0.34.5` its parent declares — added to clear a CVE in an image path this application never executes —
is a good way to take production down for no benefit. It has been reverted; the advisory is documented
as unreachable in the README instead.

### Function sizes, measured

Traced sizes for this app with the include in place, against a 250 MB limit:

| Function | Size |
| --- | --- |
| `/app/conversations/[id]`, `/app/documents/[id]` | ~121 MB |
| `/app`, `/app/settings`, `/app/components` | ~121 MB |
| `/api/ingest` | ~114 MB |
| `/api/chat` | ~112 MB |
| auth pages, landing, OG image | 6–7 MB |

Regenerate the table any time with the script in step 7's verification note.

### Model weights and the cache directory

Do **not** set `TRANSFORMERS_CACHE_DIR`. Transformers.js defaults to a directory inside `node_modules`,
which is **read-only** on Vercel; `src/lib/embeddings/local.ts` detects `process.env.VERCEL` and points
the cache at **`/tmp`**, the only writable path in a function. `/tmp` survives for the life of a warm
instance, so the ~34 MB download happens once per cold instance and is reused by every warm invocation.

Set it explicitly only for a container deployment with a real volume, where you can bake the weights in
at image-build time and never download at runtime at all.

**If the function cannot fit or cold starts are unacceptable**, the fix is *not* a paid embedding API.
`EmbeddingProvider` has a second real implementation: set `EMBEDDING_PROVIDER=openrouter` with a free
embedder (`nvidia/nemotron-3-embed-1b:free`, `liquid/lfm-2.5-embedding-350m:free`) and
`RETRIEVAL_RERANKER=openrouter` with `nvidia/llama-nemotron-rerank-vl-1b-v2:free`. Both are enforced to
end in `:free` at boot.

> Switching the embedder is **a new collection and a full re-ingest**, never a config edit. bge-small is
> 384 dimensions and `nvidia/nemotron-3-embed-1b:free` is 2048, so `EMBEDDING_DIMENSIONS` and
> `QDRANT_COLLECTION` both move with it, and every document has to be embedded again. `space.ts` exists
> to stop you mixing two embedding spaces, and it will refuse the search rather than silently degrade it.

---

## 8. Migrations, then the seed

Run both from your machine, against production, with the production `DATABASE_URL` in your environment.

```bash
npx drizzle-kit migrate
```

That is what applies the SQL files in `drizzle/` to the database — it creates the tables, the indexes
and the generated `tsvector` column. It is idempotent; running it twice is a no-op.

```bash
npm run db:seed
```

This ingests the four public-domain documents in `evals/dataset/` through the **real** chunk → embed →
index stages and produces the demo conversations by calling the shipping `answer()`. It runs on your
machine, so it does not depend on the Vercel function's inference working — which is convenient and is
also why it is **not** evidence that the function's inference works. Test that separately (step 9).

`npm run db:seed` is idempotent. `npm run db:reset-demo` rebuilds the conversations and keeps the
documents. `npm run db:seed -- --force` rebuilds the corpus, which is what a chunk-budget change needs.

### Confirm the documents reached `ready` in production

```bash
psql "$DATABASE_URL" -c "select title, status, page_count, embedding_model from documents order by created_at;"
```

All four must read `ready`. Anything stuck in `embedding` or `indexing` means the seed did not finish.

### Confirm the payload indexes exist in the production cluster

```bash
curl -s -H "api-key: $QDRANT_API_KEY" "$QDRANT_URL/collections/marginalia_chunks" \
  | python -c "import json,sys; d=json.load(sys.stdin)['result']; print('points:', d['points_count']); print('payload indexes:', list(d.get('payload_schema',{}).keys()))"
```

You want a non-zero point count and **both** `user_id` and `document_id` listed. If either is missing,
filtered search still returns correct results — it just scans instead of using an index, and the
symptom is latency that grows with the collection rather than an error.

---

## 9. Live smoke test

In order. Stop at the first failure; each step depends on the one before.

1. **Landing page loads** and is styled. `curl -sI <url>` should show `content-security-policy` and
   `strict-transport-security`.
2. **"Open the demo"** lands on a populated conversation with a visible Evidence Rail — ticks in the
   right-hand strip of the paper sheet, before you type anything.
3. **Ask a follow-up** and watch it stream, with `[n]` citation chips appearing inline.
4. **Click a citation** — the viewer scrolls to the passage and inks it.
5. **Expand "Show retrieval"** — real dense/lexical ranks and scores, not placeholders.
6. **Sign up a fresh account.** Note: `requireEmailVerification` is on and no mail provider is
   configured, so the verification link is only printed to the server log. Read it in **Vercel →
   Project → Logs**, or configure a provider in `src/lib/email.ts`.
7. **Upload a ~10 MB PDF** and watch all five stages: `uploaded → extracting → chunking → embedding →
   indexing → ready`.
8. **Ask a question of it**, then **ask something it does not cover** and confirm the refusal is honest
   rather than a plausible-looking guess.
9. **Check the cost readout** under the answer: `$0.00 · free tier`, with real token counts.
10. **Verify the demo account cannot upload** — the dropzone is hidden, and the Server Action and the
    Blob token route both refuse it server-side.
11. **Both themes**, and **a phone**, at 390 px.

### A quick way to check the function's inference without the UI

`regenerate-message` skips the daily question counter but still runs retrieval, so it exercises
embedding without spending a question:

```bash
curl -s -c cj.txt -o /dev/null "<url>/demo"                       # sign in as the demo user
curl -s -b cj.txt -X POST -H "Content-Type: application/json" \
  -d '{"conversationId":"<id>","question":"x","trigger":"regenerate-message"}' \
  "<url>/api/chat"
```

An error mentioning `libonnxruntime` means step 7's tracing fix has not deployed.

---

## 10. Free-tier ceilings, in one place

| Service | Ceiling | What happens at it |
| --- | --- | --- |
| Vercel Hobby | ~300 s per function with Fluid on; non-commercial | Function killed; ingestion resumes on the next invocation |
| Vercel cron | **once per day minimum** | Not used by this app; the pipeline re-invokes itself instead |
| Neon Free | 0.5 GB; scales to zero | First request after idle pays ~500 ms |
| Qdrant Free | 1 GB, 1 node | Upserts start failing; the app's 2,000-page per-user ceiling is what keeps you clear of it |
| OpenRouter `:free` | ~20 req/min, **50 req/day** with no credits purchased | The app counts against 50 itself and says "the free model pool is exhausted for today" with a reset time |
| Vercel Blob | Free-tier storage | Upload refused |

> The 50/day figure is measured from OpenRouter's own 429 body (`X-RateLimit-Limit: 50`), not from the
> documentation, which describes 1000/day — that number applies to an account that has purchased at
> least 10 credits. This one has not.

Per-user application limits (25 documents, 2,000 pages, 100 questions/day, 25 MB per upload, 50¢/day)
are in `src/lib/limits.ts` and enforced in Postgres inside the transaction of the write they constrain.
The demo account has a lower question cap so one visitor cannot spend the shared pool for the rest.

---

## 11. Known rough edges

- **The demo workspace's "Download original" returns 404.** Its documents are seeded from committed text
  and never had a stored file, so there are no bytes to serve. The route reports that correctly.
- **A question that fails during retrieval still counts against the daily limit.** The question row is
  inserted before retrieval runs, so an infrastructure failure spends the user's allowance and returns
  nothing. Use `trigger: "regenerate-message"` when testing, and consider refunding the count on a
  non-`LimitError` failure.
- **`/api/chat` answers an unauthenticated request with a 307 to `/sign-in`**, because
  `requireConversationAccess` is written for pages. A 401 would be the better answer for a `fetch`.
- **Rate limiting is in-memory and therefore per-instance.** N warm instances enforce a limit up to N
  times looser. The durable limits are counted in Postgres, so this costs a few extra requests and never
  an extra document or message. `src/lib/rate-limit.ts` carries the Upstash upgrade path.
