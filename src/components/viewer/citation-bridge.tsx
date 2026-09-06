"use client";

import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
} from "react";

import type { InkName } from "@/lib/ink";

/**
 * THE WIRE BETWEEN THE CONVERSATION AND THE PAGE.
 *
 * Clicking a citation chip has to reach across the workbench: the chip is in
 * the conversation pane, the highlight belongs to the reading pane, and below
 * 1024px the two are separate tabs. They are siblings in the tree with a
 * resizable separator between them, so there is no component that naturally
 * owns both.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY AN EXTERNAL STORE AND NOT CONTEXT STATE
 *
 * The obvious version is `useState` in a shared provider. It has one problem
 * that matters: the conversation pane has to PUBLISH its citations upward — it
 * is the only thing that knows what has been cited, in what ink, answering
 * which question — and publishing derived state upward from a child means
 * calling setState from an effect. That is the cascading-render pattern React
 * warns about, and here it would run on every streamed token.
 *
 * A store outside React inverts it. The conversation pane writes into an
 * external system (which is what effects are actually for), the reading pane
 * subscribes through `useSyncExternalStore`, and neither re-renders because of
 * the other. Publishing 40 citations while an answer streams costs nothing in
 * the pane that is streaming it.
 */

/** One cited passage, everywhere it needs to be understood. */
export interface CitationMark {
  /** `${messageId}:${marker}` — stable across re-renders and reloads. */
  id: string;
  messageId: string;
  /** The [n] in the answer. */
  marker: number;
  documentId: string;
  documentTitle: string;
  pageFrom: number;
  pageTo: number;
  /** What to find on the page. Null only for very old rows. */
  quotedText: string | null;
  /** The question this answer was given to. Shown in the rail's popover. */
  question: string;
  /**
   * 0 for the most recent answer in the thread, 1 for the one before it, and
   * so on. The rail draws age as opacity: this conversation's newest evidence
   * is what you are reading, and older marks are context.
   */
  answerAge: number;
}

export interface BridgeState {
  /** Every citation in the conversation, in thread order. */
  marks: CitationMark[];
  /** documentId -> ink, from the conversation's scope order. */
  inks: Record<string, InkName>;
  /**
   * The citation the page is currently lit for.
   *
   * `nonce` increments on every activation, including re-activating the same
   * mark — which is what makes clicking a chip twice re-run the ink-in wipe
   * rather than doing nothing.
   */
  active: { markId: string; nonce: number } | null;
  /** The document the reading pane should show. Null means "whatever it opened with". */
  activeDocumentId: string | null;
  /**
   * Increments whenever an activation wants the document tab on a narrow
   * screen. The workbench compares it against its own last manual choice, so
   * the most recent intent wins without an effect on either side.
   */
  tabNonce: number;
}

const EMPTY: BridgeState = {
  marks: [],
  inks: {},
  active: null,
  activeDocumentId: null,
  tabNonce: 0,
};

export class CitationBridge {
  private state: BridgeState = EMPTY;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): BridgeState => this.state;

  /**
   * The server has no conversation state, and rendering the rail during SSR
   * would mean rendering it empty and then popping it in. Returning the same
   * frozen object keeps the server and the first client render identical.
   */
  getServerSnapshot = (): BridgeState => EMPTY;

  private commit(next: Partial<BridgeState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  /**
   * Publish the conversation's citations.
   *
   * Reference-compared, not deep-compared: the conversation pane memoises both
   * arguments, so an unchanged reference means unchanged content. Skipping the
   * notification in that case is what keeps this safe to call from an effect
   * that runs on every render.
   */
  setConversation = (input: {
    marks: CitationMark[];
    inks: Record<string, InkName>;
  }): void => {
    if (input.marks === this.state.marks && input.inks === this.state.inks) {
      return;
    }

    // An answer can be regenerated or a conversation switched under an active
    // highlight. Dropping the activation is better than leaving the page lit
    // for a citation that no longer exists.
    const stillExists =
      this.state.active !== null &&
      input.marks.some((mark) => mark.id === this.state.active?.markId);

    this.commit({
      marks: input.marks,
      inks: input.inks,
      active: stillExists ? this.state.active : null,
    });
  };

  /**
   * Light a citation: switch the reading pane to its document, ask a narrow
   * layout for the document tab, and bump the nonce so the wipe replays.
   */
  activate = (markId: string): void => {
    const mark = this.state.marks.find((candidate) => candidate.id === markId);
    if (!mark) return;

    this.commit({
      active: { markId, nonce: (this.state.active?.nonce ?? 0) + 1 },
      activeDocumentId: mark.documentId,
      tabNonce: this.state.tabNonce + 1,
    });
  };

  /** Put the page back to nothing lit — leaving the answer's other marks. */
  clearActive = (): void => {
    if (this.state.active === null) return;
    this.commit({ active: null });
  };
}

const BridgeContext = createContext<CitationBridge | null>(null);

/**
 * Scoped to the workbench rather than the module.
 *
 * A module-level singleton would carry one conversation's citations into the
 * next one the reader opens, and the rail would show marks for a thread that
 * is no longer on screen.
 */
export function CitationBridgeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [bridge] = useState(() => new CitationBridge());
  return (
    <BridgeContext.Provider value={bridge}>{children}</BridgeContext.Provider>
  );
}

export function useCitationBridge(): CitationBridge {
  const bridge = useContext(BridgeContext);
  if (!bridge) {
    throw new Error(
      "useCitationBridge must be used inside a CitationBridgeProvider.",
    );
  }
  return bridge;
}

export function useBridgeState(): BridgeState {
  const bridge = useCitationBridge();
  return useSyncExternalStore(
    bridge.subscribe,
    bridge.getSnapshot,
    bridge.getServerSnapshot,
  );
}

/** The id a chip and a rail mark agree on, without either inventing a format. */
export function markId(messageId: string, marker: number): string {
  return `${messageId}:${marker}`;
}
