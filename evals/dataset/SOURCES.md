# Corpus sources and licences

Four real documents. Every one is in the public domain, every one is fetched from a stable
government endpoint, and every one is committed to this repository as converted plain text with a
sha256 pin in [`manifest.json`](manifest.json).

This corpus is used twice: by the evaluation harness (`npm run eval`) and by the demo seed
(`npm run db:seed`). Both read the same committed bytes, so the documents a visitor sees in the demo
are the documents the published scores were measured on.

---

## 45 CFR Part 164 — Security and Privacy (HIPAA)

- **Kind** — a long federal regulation
- **Source** — <https://www.ecfr.gov/api/versioner/v1/full/2024-10-01/title-45.xml?part=164>
- **Publisher** — Office of the Federal Register / Government Publishing Office, via the eCFR API
- **Edition** — as in force 2024-10-01
- **Licence** — **Public domain.** An edition of the Code of Federal Regulations is a work of the
  United States Government and is not subject to copyright under
  [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105).
- **Converted text** — `hipaa-45-cfr-164.txt`, 251,443 characters

The Security Rule, the Privacy Rule, and the Breach Notification Rule in one part. Chosen because it
is dense with internal cross-references and near-duplicate deadlines: two different 60-day clocks
that mean different things, "Required" versus "Addressable" specifications, several distinct grounds
for denying access. Retrieval that returns *a* plausible section rather than *the* right one produces
an answer that looks correct and is not.

## CDC Clinical Practice Guideline for Prescribing Opioids for Pain — United States, 2022

- **Kind** — a clinical guideline
- **Source** — <https://www.cdc.gov/mmwr/volumes/71/rr/rr7103a1.htm>
- **Publisher** — Centers for Disease Control and Prevention, *MMWR Recommendations and Reports*
  71(3):1–95
- **Licence** — **Public domain.** MMWR states that all material in the series is in the public
  domain and may be reproduced without permission; citation of the source is requested and is given
  above.
- **Converted text** — `cdc-opioid-guideline-2022.txt`, 433,463 characters

Twelve numbered recommendations wrapped in a long evidence review. Chosen because the recommendation
a question is about is usually one paragraph inside ninety pages of surrounding discussion of the
same vocabulary — the hardest retrieval shape in the corpus, and the one that exposed a chunking bug
(see below).

Layout-heavy tables are dropped by the converter rather than flattened. MMWR's recommendation tables
become a run of disconnected numbers when flattened, which matches many queries weakly and none of
them well; the prose recommendations they summarise are kept.

## NIST SP 800-63B — Digital Identity Guidelines: Authentication and Lifecycle Management

- **Kind** — a technical standard, largely tabular
- **Source** — <https://pages.nist.gov/800-63-3/sp800-63b.html>
- **Publisher** — National Institute of Standards and Technology, U.S. Department of Commerce
- **Licence** — **Public domain.** A NIST Special Publication is a work of the United States
  Government and is not subject to copyright under 17 U.S.C. § 105.
- **Converted text** — `nist-sp-800-63b.txt`, 172,094 characters, including 87 table rows

Chosen for its **tables**: authenticator types against verifier requirements, assurance levels
against permitted methods. Its converter preserves them as pipe-delimited rows rather than dropping
them, because a corpus of prose alone would not show whether retrieval can answer "which
authenticators are permitted at AAL2".

Note that this revision was superseded by SP 800-63-4 in August 2025. That is stated in the document
itself and is left in the text deliberately — a document that announces its own obsolescence is a
realistic thing to have in a library, and the demo can answer a question about it correctly.

The page carries a build timestamp that changes on every fetch. The converter strips it, so the
sha256 pin reports drift only when the document itself is amended.

## FAR 52.212-4 — Contract Terms and Conditions, Commercial Products and Commercial Services

- **Kind** — a standard contract template
- **Source** —
  <https://www.ecfr.gov/api/versioner/v1/full/2024-10-01/title-48.xml?part=52&section=52.212-4>
- **Publisher** — Office of the Federal Register / Government Publishing Office, via the eCFR API
- **Edition** — as in force 2024-10-01
- **Licence** — **Public domain**, as above.
- **Converted text** — `far-52-212-4.txt`, 38,371 characters

The clause incorporated into essentially every U.S. federal commercial-item contract: inspection,
assignment, disputes, excusable delays, invoicing, risk of loss, taxes, both kinds of termination,
title, warranty, limitation of liability, order of precedence. Chosen because its clauses are
**short** — several are a single sentence — which is where the lexical channel earns its place and
dense search alone tends not to.

---

## Verifying the corpus

```bash
npm run eval:fetch
```

Re-downloads all four, re-converts them, and compares against the pins. A mismatch does not change
any score — the eval and the seed always read the committed text — but it tells you a source has
been amended. To adopt the new text deliberately:

```bash
npm run eval:fetch -- --update
npm run eval:pages -- --write
```

The second command re-derives `expected_pages` in `questions.jsonl` from the phrases, because block
numbers move when the text does.

## Why the text is committed rather than fetched at run time

So that a run today and a run in a year measure the same corpus. An eval whose dataset can move
under it is not a measurement, and a demo whose corpus depends on four government websites being up
is not a demo. The fetcher exists to prove the committed text is what the cited source actually says,
not to be on the critical path.

The cost is that neither the eval nor the demo exercises PDF or DOCX extraction — the corpus is
already text. That is a real gap and it is covered separately by `src/lib/ingest/extract.test.ts`.
