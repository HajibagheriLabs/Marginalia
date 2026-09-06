import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { EVALS_DIR, sha256 } from "./dataset";
import type { EvalQuestion } from "./types";

/**
 * Loading and validating questions.jsonl.
 *
 * JSONL rather than one JSON array for one reason: a diff. Adding a question
 * is a one-line addition, and a reviewer can see which question changed
 * without reading a reindented array. It also means a syntax error is confined
 * to the line that has it, and this loader reports that line number.
 *
 * Validated with Zod at the boundary, like every other input in this codebase.
 * A typo'd field name in a hand-written dataset is otherwise `undefined` at
 * scoring time, which silently makes a question unscoreable rather than
 * failing.
 */

const baseSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  document: z.string().min(1).nullable(),
  expected_pages: z.array(z.number().int().positive()),
  expected_phrases: z.array(z.string().min(1)),
  answerable: z.boolean(),
  note: z.string().optional(),
});

const questionSchema = baseSchema.superRefine((question, ctx) => {
  // The two halves of the file's contract, checked rather than trusted,
  // because both failures produce a plausible-looking score.
  if (question.answerable) {
    if (question.document === null) {
      ctx.addIssue({
        code: "custom",
        message: "an answerable question must name the document holding the answer",
      });
    }
    if (question.expected_pages.length === 0) {
      ctx.addIssue({
        code: "custom",
        message:
          "an answerable question with no expected_pages can never be scored as recalled — run `npm run eval:pages -- --write`",
      });
    }
    if (question.expected_phrases.length === 0) {
      ctx.addIssue({
        code: "custom",
        message:
          "an answerable question with no expected_phrases contributes nothing to citation support",
      });
    }
  } else if (
    question.expected_pages.length > 0 ||
    question.expected_phrases.length > 0
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "an unanswerable question must have empty expected_pages and expected_phrases — there is nothing in the corpus to find",
    });
  }
});

/**
 * The same shape without the "must already be resolved" rules.
 *
 * Everything else is still enforced: an unanswerable question with phrases is
 * a contradiction whether or not pages have been derived yet.
 */
const lenientSchema = baseSchema.superRefine((question, ctx) => {
  if (!question.answerable) {
    if (
      question.expected_pages.length > 0 ||
      question.expected_phrases.length > 0
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "an unanswerable question must have empty expected_pages and expected_phrases — there is nothing in the corpus to find",
      });
    }
    return;
  }
  if (question.document === null) {
    ctx.addIssue({
      code: "custom",
      message: "an answerable question must name the document holding the answer",
    });
  }
  if (question.expected_phrases.length === 0) {
    ctx.addIssue({
      code: "custom",
      message:
        "an answerable question needs expected_phrases — they are what expected_pages is derived from",
    });
  }
});

export interface QuestionSet {
  questions: EvalQuestion[];
  /** sha256 of the raw file, so an edited set never diffs against an old one. */
  digest: string;
}

/**
 * `lenient` skips the "an answerable question must have expected_pages" rule.
 *
 * Exactly one caller passes it: `resolve-pages.ts`, which exists to FILL that
 * field and therefore has to be able to read the file before it is filled. The
 * strict form is what the eval run itself uses, so an unresolved question set
 * fails the run loudly rather than scoring every unresolved question as a
 * retrieval miss.
 */
export async function loadQuestions(
  options: { lenient?: boolean } = {},
): Promise<QuestionSet> {
  const file = path.join(EVALS_DIR, "questions.jsonl");
  const raw = await readFile(file, "utf8");
  const schema = options.lenient ? lenientSchema : questionSchema;

  const questions: EvalQuestion[] = [];
  const seen = new Set<string>();

  raw.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    // Blank lines and `#` comments are allowed so the file can be grouped by
    // document with a heading. JSONL parsers vary on this; ours is explicit.
    if (!trimmed || trimmed.startsWith("#")) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `questions.jsonl:${index + 1} is not valid JSON — ${(error as Error).message}`,
      );
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `questions.jsonl:${index + 1} — ${result.error.issues
          .map((issue) => `${issue.path.join(".") || "(row)"}: ${issue.message}`)
          .join("; ")}`,
      );
    }

    if (seen.has(result.data.id)) {
      // Ids appear in the report and in `--compare`. A duplicate would make one
      // question's outcome silently overwrite another's in any keyed diff.
      throw new Error(
        `questions.jsonl:${index + 1} — duplicate id "${result.data.id}"`,
      );
    }
    seen.add(result.data.id);
    questions.push(result.data);
  });

  if (questions.length === 0) {
    throw new Error("questions.jsonl contains no questions");
  }

  return { questions, digest: sha256(raw) };
}
