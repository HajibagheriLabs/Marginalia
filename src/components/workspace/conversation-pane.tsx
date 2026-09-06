"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { DefaultChatTransport } from "ai";
import { useChat } from "@ai-sdk/react";
import { MessageSquare } from "lucide-react";
import { toast } from "sonner";

import { Composer } from "@/components/composer";
import {
  markId,
  useCitationBridge,
  type CitationMark,
} from "@/components/viewer/citation-bridge";
import { ErrorState } from "@/components/error-state";
import { MessageView } from "@/components/conversation/message-view";
import { ScopeSelector } from "@/components/conversation/scope-selector";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DocumentStatus } from "@/db/schema";
import {
  messageCitations,
  messageText,
  type MarginaliaUIMessage,
  type ScopeDocument,
} from "@/lib/chat/types";
import { inkForIndex, inkOrder, type InkName } from "@/lib/ink";
import { DOCUMENT_STATUS_META } from "@/lib/document-status";
import { cn } from "@/lib/utils";
import {
  createConversation,
  getSuggestedQuestions,
  setConversationScope,
} from "@/server/actions/conversations";

/**
 * THE CONVERSATION PANE.
 *
 * Header, scope, messages, composer — with the whole answer engine behind the
 * composer's send button.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS COMPONENT OWNS, AND WHAT IT DOES NOT
 *
 * It owns the transport and the rendering. It does NOT own the thread: the
 * route handler reads history and scope from the database under the session's
 * user id, and `prepareSendMessagesRequest` below deliberately throws away the
 * message array the AI SDK wants to post, sending a conversation id and one
 * question instead. A client that can send history can send history that never
 * happened, and the document scope is what keeps one user's vector search out
 * of another user's documents.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * A CONVERSATION IS CREATED BY THE FIRST QUESTION
 *
 * Opening the workspace does not write a row. `conversation` is null until
 * someone asks something, at which point `createConversation` runs, the rail
 * refreshes, and the question is sent against the new id — all before the first
 * token, and without a navigation, so the streaming answer lands in the pane
 * the question was typed into. Threads that are opened and abandoned never
 * exist, which is why the rail is not full of empty ones.
 */

export interface ConversationPaneProps {
  /** Null for a conversation that has not been created yet. */
  conversation: { id: string; title: string | null } | null;
  /** The thread, rebuilt from the database. Empty for a new conversation. */
  initialMessages: MarginaliaUIMessage[];
  /** The conversation's document scope, IN SCOPE ORDER — this assigns the inks. */
  initialScope: ScopeDocument[];
  /** Everything the user owns, for the scope picker. */
  documents: { id: string; title: string; status: DocumentStatus }[];
}

export function ConversationPane({
  conversation,
  initialMessages,
  initialScope,
  documents,
}: ConversationPaneProps) {
  const router = useRouter();

  const [conversationId, setConversationId] = useState(conversation?.id ?? null);
  const [scope, setScope] = useState<ScopeDocument[]>(initialScope);
  const [aborted, setAborted] = useState(false);
  /**
   * Example questions, tagged with the scope they were derived from. Tagging
   * rather than clearing: the scope can change while a fetch is in flight, and
   * a suggestion about a document that is no longer selected would send a
   * question that cannot be answered.
   */
  const [suggestions, setSuggestions] = useState<{
    key: string;
    questions: string[];
  }>({ key: "", questions: [] });

  const scopeIds = useMemo(() => scope.map((row) => row.id), [scope]);

  /**
   * The transport is built once. It reads the conversation id out of the
   * per-request body rather than closing over state, so it never goes stale
   * when a conversation is created mid-session.
   */
  const transport = useMemo(
    () =>
      new DefaultChatTransport<MarginaliaUIMessage>({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages, body, trigger }) => ({
          body: {
            conversationId: (body as { conversationId?: string } | undefined)
              ?.conversationId,
            question: lastUserText(messages),
            trigger,
          },
        }),
      }),
    [],
  );

  const chat = useChat<MarginaliaUIMessage>({
    messages: initialMessages,
    transport,
    // Deltas arrive faster than the eye resolves, and every one of them
    // re-parses the answer's markdown. 50ms is below the threshold where
    // streaming stops looking continuous and well above per-token churn.
    throttle: 50,
    onError: (error) => console.error("[chat]", error),
  });

  const streaming = chat.status === "streaming" || chat.status === "submitted";

  /* ── INK ASSIGNMENT ───────────────────────────────────────────────────────
   * One ink per SOURCE DOCUMENT, positional in the conversation's scope,
   * cycling citrine → rose → jade → azure. Documents that were cited earlier
   * and have since left the scope keep a colour by being appended — see
   * `inkOrder`.
   */
  const inks = useMemo(() => {
    const cited: string[] = [];
    for (const message of chat.messages) {
      for (const citation of messageCitations(message)?.citations ?? []) {
        if (!cited.includes(citation.documentId)) cited.push(citation.documentId);
      }
    }
    return new Map<string, InkName>(
      inkOrder(scopeIds, cited).map((id, index) => [id, inkForIndex(index)]),
    );
  }, [chat.messages, scopeIds]);

  const inkFor = useCallback(
    (documentId: string): InkName => inks.get(documentId) ?? "citrine",
    [inks],
  );

  /* ── PUBLISHING THE EVIDENCE ──────────────────────────────────────────────
   * Every citation in the thread, flattened, each carrying the question its
   * answer was given to and how old that answer is. This is the only place
   * that knows all three facts, which is why the conversation publishes and
   * the reading pane subscribes rather than the other way round.
   *
   * `answerAge` counts back from the newest ANSWER, not the newest message: a
   * scope note or an unanswered question in between must not make this
   * conversation's most recent evidence look old on the rail.
   */
  const marks = useMemo<CitationMark[]>(() => {
    const answers: { messageId: string; question: string; citations: CitationMark[] }[] = [];
    let question = "";

    for (const message of chat.messages) {
      if (message.role === "user") {
        question = messageText(message);
        continue;
      }
      if (message.role !== "assistant") continue;

      const citations = messageCitations(message)?.citations ?? [];
      if (citations.length === 0) continue;

      answers.push({
        messageId: message.id,
        question,
        citations: citations.map((citation) => ({
          id: markId(message.id, citation.marker),
          messageId: message.id,
          marker: citation.marker,
          documentId: citation.documentId,
          documentTitle: citation.documentTitle,
          pageFrom: citation.pageFrom,
          pageTo: citation.pageTo,
          quotedText: citation.quotedText,
          question,
          answerAge: 0,
        })),
      });
    }

    const newest = answers.length - 1;
    return answers.flatMap((answer, index) =>
      answer.citations.map((citation) => ({
        ...citation,
        answerAge: newest - index,
      })),
    );
  }, [chat.messages]);

  /** The ink map as a plain object, which is what the bridge carries. */
  const inkRecord = useMemo(
    () => Object.fromEntries(inks) as Record<string, InkName>,
    [inks],
  );

  const bridge = useCitationBridge();
  useEffect(() => {
    // Writing to an external store, which is what an effect is for. Both
    // arguments are memoised and the bridge compares them by reference, so a
    // render that changed nothing notifies nobody — this stays cheap while an
    // answer is streaming a token at a time.
    bridge.setConversation({ marks, inks: inkRecord });
  }, [bridge, marks, inkRecord]);

  /* ── EXAMPLE QUESTIONS ────────────────────────────────────────────────────
   * Derived from the documents that are ACTUALLY selected, so they change with
   * the scope. Only fetched for an empty thread: once there is a conversation
   * to read, examples are clutter.
   */
  const suggestionKey = scopeIds.join(",");
  const threadIsEmpty = chat.messages.length === 0;

  useEffect(() => {
    if (!threadIsEmpty || suggestionKey === "") return;

    let cancelled = false;
    void getSuggestedQuestions(suggestionKey.split(",")).then((result) => {
      if (cancelled || !result.ok) return;
      setSuggestions({
        key: suggestionKey,
        questions: result.suggestions.map((item) => item.question),
      });
    });

    return () => {
      cancelled = true;
    };
  }, [suggestionKey, threadIsEmpty]);

  // Shown only when they still describe the current selection. Anything else is
  // a question about a document this conversation is no longer searching.
  const visibleSuggestions =
    suggestions.key === suggestionKey ? suggestions.questions : [];

  /* ── ASKING ───────────────────────────────────────────────────────────── */

  const ask = useCallback(
    async (question: string) => {
      setAborted(false);
      chat.clearError();

      let id = conversationId;

      if (!id) {
        const created = await createConversation(scopeIds);
        if (!created.ok) {
          toast.error(created.error);
          return;
        }
        id = created.conversation.id;
        setConversationId(id);
        // The rail gains the new thread. Safe to do mid-flight: the URL has not
        // changed, so this re-renders the same route with the same props.
        router.refresh();
      }

      await chat.sendMessage({ text: question }, { body: { conversationId: id } });
      router.refresh();
    },
    [chat, conversationId, router, scopeIds],
  );

  const retry = useCallback(async () => {
    if (!conversationId) return;
    chat.clearError();
    await chat.regenerate({ body: { conversationId } });
  }, [chat, conversationId]);

  const stop = useCallback(() => {
    setAborted(true);
    void chat.stop();
  }, [chat]);

  /* ── SCOPE ────────────────────────────────────────────────────────────── */

  const changeScope = useCallback(
    async (next: string[]) => {
      // Optimistic, in the order the selector produced, so the swatches move
      // with the click rather than after a round trip.
      setScope(
        next
          .map((id) => documents.find((row) => row.id === id))
          .filter((row) => row !== undefined)
          .map((row) => ({
            id: row.id,
            title: row.title,
            status: row.status,
            ready: row.status === "ready",
          })),
      );

      if (!conversationId) return;

      const result = await setConversationScope(conversationId, next);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      // The server is authoritative about ORDER — it keeps retained ids in
      // place so their inks do not move — so the optimistic scope is replaced
      // rather than merged.
      setScope(result.scope);

      const note = result.note;
      if (note) {
        chat.setMessages((messages) => [
          ...messages,
          {
            id: note.id,
            role: "system",
            parts: [{ type: "text", text: note.content, state: "done" }],
          },
        ]);
      }
      router.refresh();
    },
    [chat, conversationId, documents, router],
  );

  /* ── COMPOSER STATE ───────────────────────────────────────────────────── */
  const composer = composerState(scope);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-0 flex-1 flex-col bg-surface">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-edge px-4">
          <h2 className="truncate text-body font-medium text-text">
            {conversation?.title ?? "New conversation"}
          </h2>
        </header>

        <ScopeSelector
          documents={documents}
          selectedIds={scopeIds}
          inks={inks}
          onChange={(next) => void changeScope(next)}
          disabled={streaming}
        />

        <MessageList
          messages={chat.messages}
          inkFor={inkFor}
          streaming={streaming}
          aborted={aborted}
          error={chat.error}
          onRetry={() => void retry()}
          suggestions={visibleSuggestions}
          onAsk={(question) => void ask(question)}
          canAsk={composer.canAsk}
        />

        <div className="shrink-0 border-t border-edge p-3">
          <Composer
            disabled={!composer.canAsk}
            disabledReason={composer.reason}
            streaming={streaming}
            onStop={stop}
            onSubmit={(question) => void ask(question)}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

/* ========================================================================== *
 * THE MESSAGE LIST
 * ========================================================================== */

function MessageList({
  messages,
  inkFor,
  streaming,
  aborted,
  error,
  onRetry,
  suggestions,
  onAsk,
  canAsk,
}: {
  messages: MarginaliaUIMessage[];
  inkFor: (documentId: string) => InkName;
  streaming: boolean;
  aborted: boolean;
  error: Error | undefined;
  onRetry: () => void;
  suggestions: string[];
  onAsk: (question: string) => void;
  canAsk: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  /**
   * Follow the stream, but only while the reader is already at the bottom.
   *
   * Yanking someone back down mid-scroll because a token arrived is the single
   * most common way a streaming interface becomes unreadable — and this one is
   * built for reading long answers with sources in them.
   */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !pinnedRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, streaming]);

  const lastId = messages[messages.length - 1]?.id;

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinnedRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-5"
    >
      {messages.length === 0 ? (
        <EmptyThread
          suggestions={suggestions}
          onAsk={onAsk}
          canAsk={canAsk}
        />
      ) : (
        messages.map((message) => (
          <MessageView
            key={message.id}
            message={message}
            inkFor={inkFor}
            streaming={streaming && message.id === lastId}
          />
        ))
      )}

      {/* ABORTED. The engine returns without persisting when the request is
          cancelled, so the text on screen is genuinely not in the database.
          Saying so is the honest version; leaving it looking saved is not. */}
      {aborted && !streaming ? (
        <p className="measure text-body-sm text-text-faint">
          Stopped. This answer was not saved — ask again to start over.
        </p>
      ) : null}

      {error ? (
        <ErrorState
          className="measure"
          title={error.message}
          action={
            <Button size="sm" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

/**
 * The empty thread.
 *
 * One sentence and three questions drawn from the selected documents' own
 * headings. Generic examples would be worse than none — "What are the payment
 * terms?" above a clinical guideline teaches the reader that this tool does not
 * know what it is holding.
 */
function EmptyThread({
  suggestions,
  onAsk,
  canAsk,
}: {
  suggestions: string[];
  onAsk: (question: string) => void;
  canAsk: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-2 text-center">
      <MessageSquare aria-hidden className="size-5 shrink-0 text-text-faint" />
      <p className="max-w-[44ch] text-body text-text-muted">
        Ask a question and the answer will cite the passages it came from.
      </p>

      {canAsk && suggestions.length > 0 ? (
        <ul className="flex w-full max-w-[400px] flex-col gap-1.5">
          {suggestions.map((question) => (
            <li key={question}>
              <button
                type="button"
                onClick={() => onAsk(question)}
                className={cn(
                  "w-full rounded-panel border border-edge bg-surface-raised px-3 py-2",
                  "text-left text-body-sm text-text-muted hover:text-text",
                )}
              >
                {question}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ========================================================================== *
 * HELPERS
 * ========================================================================== */

/**
 * Whether the composer works, and — when it does not — WHY.
 *
 * Every branch names the specific document and the specific reason, because
 * each has a different fix: one is fixed by selecting something, one by
 * waiting, one by retrying ingestion. "Cannot ask a question right now" would
 * be true for all three and useful for none.
 */
function composerState(scope: ScopeDocument[]): {
  canAsk: boolean;
  reason?: string;
} {
  if (scope.length === 0) {
    return { canAsk: false, reason: "Select at least one document." };
  }

  const failed = scope.find((row) => row.status === "failed");
  if (failed) {
    return {
      canAsk: false,
      reason: `${failed.title} could not be processed. Open it to retry.`,
    };
  }

  const pending = scope.find((row) => !row.ready);
  if (pending) {
    const stage =
      DOCUMENT_STATUS_META[pending.status as DocumentStatus]?.label.toLowerCase() ??
      "processing";
    return {
      canAsk: false,
      reason: `${pending.title} is still ${stage}.`,
    };
  }

  return { canAsk: true };
}

/** The question being asked, taken from the last user turn in the thread. */
function lastUserText(messages: MarginaliaUIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    return message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return "";
}
