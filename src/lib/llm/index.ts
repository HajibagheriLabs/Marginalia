/**
 * The answer engine's public surface.
 *
 * A barrel and nothing else. Call sites import `answer` from `@/lib/llm` and
 * never reach for the AI SDK, the provider, or a model id — the model is a
 * string in an env var, and keeping it that way is the point.
 */

export { answer } from "./answer";
export {
  AnswerError,
  type AnswerDeps,
  type AnswerEvent,
  type AnswerParams,
  type AnswerSummary,
  type ModelRunner,
  type ShortCircuitReason,
} from "./types";

export {
  parseMarkers,
  validateCitations,
  type CitationRecord,
  type ValidationResult,
} from "./citations";

export { PROMPT_VERSION, buildSystemPrompt, noContextAnswer } from "./prompt";
export { buildContext, buildUserPrompt, formatPassage } from "./context";
export {
  classifyFailure,
  isFailoverWorthy,
  modelPool,
  poolFailureMessage,
  type PoolFailure,
} from "./models";
export { createModelRunner } from "./runner";
