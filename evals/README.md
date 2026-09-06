# Evaluation harness

An offline measurement of the retrieval pipeline: three real documents, 44 hand-written questions,
and a scored run of the same `retrieve()` and `answer()` the product uses.

It exists because every interesting decision in this codebase — chunk size, RRF's `k`, the relevance
floor, whether reranking is worth its latency — was made from reasoning, and reasoning is how you
choose what to try, not how you find out whether it worked. Several constants in `src/lib/` carry a
comment ending in "worth measuring once the eval harness exists". This is that.

```bash
npm run eval                       # every question, shipping defaults
npm run eval -- --retrieval-only   # retrieval metrics only; calls no model
npm run eval -- --help             # every knob
npm run eval -- --compare A B      # diff two runs
```

The first run ingests the corpus, which takes a couple of minutes of local CPU. Every run after that
reuses it unless a chunking knob changed.

---

## Read this before you read a score

**44 hand-written questions over three documents is not a benchmark.** It is a smoke detector. It
will catch a change that breaks retrieval, and it will not tell you that this system is better than
some other system. Specifically:

- **The sample is tiny.** One question moving is 2.6 percentage points of recall@5. Treat anything
  under ~5 points as noise, and run the same config twice if you need to know.
- **The questions were written by someone who had read the documents**, which makes them cleaner and
  more answerable than real user questions. Real questions are vaguer, use the wrong vocabulary, and
  ask about things spread across three sections.
- **The corpus is three documents.** A real user has twenty-five, and retrieval gets harder as the
  distractor pool grows. Recall here is an optimistic bound.
- **Citation support is a lower bound, not a measurement.** See the metric below.
- **Refusal detection is partly a regex.** See the metric below.

The numbers are useful for comparing *this pipeline against itself*. That is the whole claim.

---

## The corpus

`dataset/` holds three public-domain documents, converted to plain text and committed:

| id | what it is | why |
| --- | --- | --- |
| `hipaa-45-cfr-164` | 45 CFR Part 164 — HIPAA Security, Privacy, and Breach Notification | A long regulation, dense with internal cross-references and near-duplicate deadlines |
| `cdc-opioid-guideline-2022` | CDC Clinical Practice Guideline for Prescribing Opioids for Pain | A clinical guideline: numbered recommendations wrapped in a lot of discursive evidence review |
| `far-52-212-4` | FAR 52.212-4 — standard commercial contract terms | A contract template: short numbered clauses, several only one sentence long |

All three are works of the United States Government or explicitly released into the public domain;
`dataset/manifest.json` records the source URL, the licence statement, and a sha256 of the converted
text.

`npm run eval:fetch` re-downloads all three, re-converts them, and checks each against its pin. A
mismatch does not change any score — the eval always reads the committed text — but it tells you the
source has been amended. `npm run eval:fetch -- --update` re-pins deliberately, after which you
should re-run `npm run eval:pages`.

**The corpus is committed as text, so this eval never exercises PDF or DOCX extraction.** That is a
deliberate trade: page numbers in `questions.jsonl` must not move because a PDF parser was upgraded.
It does mean a regression in `unpdf` handling would be invisible here. `src/lib/ingest/extract.test.ts`
covers that separately.

---

## Adding a question

Write the question, name the document, and quote a few phrases. **Do not type page numbers.**

```jsonl
{"id": "far-warranty", "question": "What does the contractor warrant about delivered items?", "document": "far-52-212-4", "expected_pages": [], "expected_phrases": ["merchantable and fit for use for the particular purpose"], "answerable": true}
```

Then:

```bash
npm run eval:pages -- --write
```

That finds every block actually containing one of your phrases and fills `expected_pages` in. Run it
without `--write` to verify an existing set; it exits non-zero if anything is stale, which makes it
usable as a pre-commit check.

**Why pages are derived rather than typed.** A hand-typed page number is a second source of truth for
something the corpus already knows. Re-fetch an amended regulation and every block after the
amendment shifts by one; change `SYNTHETIC_PAGE_TARGET_CHARS` and all of them shift. Neither raises
an error — recall just quietly falls, and it looks like a retrieval regression. Derived numbers
cannot drift.

### Writing good `expected_phrases`

- **Copy verbatim from `dataset/*.txt`.** The resolver fails loudly on a phrase it cannot find, which
  is nearly always a smart quote, an en dash, or a sentence reconstructed from memory.
- **Short and distinctive.** Five or six words that appear nowhere else. A whole sentence fails on one
  comma of drift.
- **Two or three per question**, so a chunk boundary falling mid-answer does not cost you the match.

### Writing a good unanswerable question

At least five of the 44 are deliberately unanswerable, and they are the most valuable rows in the
file — a system that always returns its best eight passages will always produce something plausible,
and refusal is the only metric that catches it.

A good one is **plausible, in-domain, and absent**. "What is the maximum civil monetary penalty for a
HIPAA violation?" is a real question about a real regulation whose answer lives in Part 160, not Part
164. Retrieval will confidently return enforcement language; the correct behaviour is to decline.

Check before adding: `grep -i "your concept" dataset/*.txt` must return nothing.

---

## The metrics

Every metric below has a **different denominator**. Comparing two of them without knowing that is how
an eval starts lying.

### Retrieval — `recall@5`, `recall@10`, `MRR`

Over **answerable questions only**. Recall of a page that does not exist is undefined, not zero;
including refusal questions would make retrieval scores fall every time one was added.

A question counts as recalled at *k* when a passage covering one of its expected pages, **in the
expected document**, appears in the first *k* candidates in final rank order. Both halves matter —
block 41 of the contract must not score for a question about block 41 of the regulation.

The match is an **interval intersection**, not equality: a chunk spans `page_from..page_to` and
routinely straddles a block boundary. Testing `pageFrom === expected` would report a miss for a
passage that contains the answer verbatim.

Scoring runs over the **full fused candidate list**, not the eight passages that survived the
relevance floor. Otherwise recall@10 would be unmeasurable, and two different failures — "retrieval
never found it" and "assembly cut it" — would be indistinguishable.

`MRR` is the one number that separates "found it first" from "found it eighth". Both are hits at
recall@10; only one of them produces a good answer, because the model reads early passages best.

### Citation validity

Over **markers**, not questions: emitted markers that mapped to a real retrieved passage.

**This should be exactly 100%.** It is not a quality metric and it is not tunable. A marker mapping to
nothing is an invented citation; `validateCitations` strips it before the answer is stored, so the
product never shows one. Anything below 100% here means the model is inventing markers at a
measurable rate — worth knowing, even though it never reaches a user.

### Citation support

Over **cited passages** on answerable questions that declared phrases: of the passages the model
cited, how many actually contain one of the expected phrases.

This is the harder question, and the one validity cannot answer. A model that cites a plausible
neighbouring passage scores 100% validity and fails here.

**It is a lower bound on faithfulness, not a measurement of it.** A cited passage may support the
claim perfectly using words that are not in the phrase list, and it would score as unsupported. Read
a drop here as a signal to go and look at the answers, not as a percentage of hallucinations.

### Refusal — both halves

Over **unanswerable questions**: did the system decline instead of inventing?

And, printed beside it, over **answerable questions**: how often did it decline something it should
have answered? Refusal accuracy alone is trivially gamed — a system that refuses everything scores
100% — so neither number means anything without the other.

**How a refusal is detected**, because one half of this is a heuristic and you should know which:

- `no-context` is **definitive**. Nothing cleared the relevance floor, `answer()` short-circuited
  without calling a model at all, and the sentence returned is a constant from `prompt.ts`. The
  system structurally could not have invented anything.
- A **phrase match** is a regex over the answer, and it is the weakest part of this harness. The
  system prompt tells the model to say plainly that the passages do not answer the question, so a
  decline reliably contains one of a small family of sentences — but the model writes it in its own
  words.

The patterns anchor on a negation *plus* a reference to the documents ("do not contain", "nothing in
these documents"), never on a bare "no". An answer that legitimately says "no, the rule does not apply
to a covered entity [3]" is a real cited answer, and counting it as a refusal would inflate refusal
accuracy while destroying the false-refusal count that exists to catch exactly that.

Every outcome in the JSON records which signal fired (`refusalSignal`), so a suspicious refusal score
can be audited question by question rather than taken on trust.

### Latency and cost

Per question, p50 and p95, **nearest-rank** rather than interpolated — every value is a real
observation, and an interpolated p95 is a number no question ever took.

Questions run **one at a time**. Concurrency would make the run faster and every latency number in it
meaningless, and would spend the shared ~20 requests/minute free-model quota fast enough to turn a
quality measurement into a rate-limit measurement.

Cost is `$0.00` and that is the real number, not a rounding: every model is a `:free` variant
validated at boot and embeddings run locally. Tokens are reported because those are real.

---

## Sweeping knobs

Every ranking constant is settable per run and recorded in the result file.

```bash
npm run eval -- --rrf-k 30 --tag rrf30
npm run eval -- --dense-weight 2 --lexical-weight 1 --tag dense-heavy
npm run eval -- --rerank --tag rerank-on
npm run eval -- --target-tokens 240 --overlap 0.2 --tag smaller-chunks   # re-ingests
npm run eval -- --compare baseline rrf30
```

Retrieval knobs re-run queries only. **Chunking knobs force a re-ingest**, because they change what
gets embedded; the ingest is cached against a hash of `(chunk config, corpus, embedding model)`, so
sweeping ten RRF constants re-ingests zero times.

`--dense-weight 0` disables the dense channel while still recording its ranks in the trace, which is
how "what would lexical-only do?" gets measured without a second code path that could differ in some
other way.

**`--rewrite` is settable and inert.** Every question here is a first turn, and `rewriteQuery` returns
the question unchanged when there is no history to resolve against. The flag is recorded so it is not
silently missing; the report header says so rather than implying it was measured. Measuring rewriting
needs multi-turn questions, which this set does not have.

---

## Result files and `--compare`

Each run writes `results/<utc-date>-<time>-<confighash>[-tag].json` — the full config, every metric,
and every per-question outcome. Result files are committed; they are the record a diff runs against.

The **config hash** covers more than the knobs: the corpus digests, the question-set digest, the
embedding model, and the prompt version are all in it, because each of them changes what the scores
mean. Two results with the same hash are comparable. Two with different hashes are comparable only if
you know which field moved — which is the first thing `--compare` prints.

```
npm run eval -- --compare baseline rrf30
```

`--compare` takes a path, a filename, or any unambiguous prefix, including a bare config hash off the
report header. It prints the aggregate deltas, then **which questions changed rank**, which is the
part you can act on: two questions fixed and one broken nets out to "+1" in recall@5 and is a
completely different situation from three questions improving slightly.

It also warns when the two runs do not cover the same questions, because aggregate deltas across
different question sets are not a like-for-like comparison and nothing in the numbers would tell you.

---

## What this harness does not measure

Stated here rather than left to be discovered:

- **PDF and DOCX extraction.** The corpus is committed text; `runExtraction` never runs.
- **Multi-turn behaviour**, including query rewriting. Every question is a first turn.
- **`answer()`'s own choice of retrieval.** The harness retrieves with this run's tuning and injects
  the result through `deps.retrieval`, the seam the answer engine's integration tests already use.
  Everything downstream — prompt, model pool, failover, marker validation, persistence — is the real
  path, but a change to *how `answer()` decides to retrieve* would not show up here.
- **Concurrency, rate limiting, and the free-pool ceiling.** Covered by unit tests, not by this.
- **Answer quality beyond citations.** Nothing here scores whether the prose is good, only whether it
  is grounded in the passages it points at.
