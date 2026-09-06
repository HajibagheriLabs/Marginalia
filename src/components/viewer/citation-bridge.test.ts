import { describe, expect, it, vi } from "vitest";

import { CitationBridge, markId, type CitationMark } from "./citation-bridge";

/**
 * THE STATE MACHINE BEHIND CLICK-TO-SOURCE.
 *
 * The store is the only part of the interaction that is testable without a
 * browser, and it is where the behaviour the reader actually notices lives:
 * whether clicking the same chip twice does anything, whether the highlight
 * survives a new answer arriving, and whether publishing citations on every
 * streamed token wakes the reading pane up forty times a second.
 */

function mark(overrides: Partial<CitationMark> = {}): CitationMark {
  const messageId = overrides.messageId ?? "message-1";
  const marker = overrides.marker ?? 1;
  return {
    messageId,
    marker,
    documentId: "doc-a",
    documentTitle: "Master Services Agreement",
    pageFrom: 14,
    pageTo: 14,
    quotedText: "Either party may terminate for convenience.",
    question: "What notice is required?",
    answerAge: 0,
    ...overrides,
    // Last, so an overridden messageId or marker still owns the id — the two
    // must never disagree, because the id is what a chip and a rail mark use
    // to mean the same citation.
    id: markId(messageId, marker),
  };
}

describe("CitationBridge", () => {
  it("starts with nothing published and nothing lit", () => {
    const bridge = new CitationBridge();
    expect(bridge.getSnapshot().marks).toEqual([]);
    expect(bridge.getSnapshot().active).toBeNull();
    expect(bridge.getSnapshot().activeDocumentId).toBeNull();
  });

  it("renders identically on the server and the first client pass", () => {
    // The rail is conversation state, and the server has none. Returning the
    // same frozen snapshot is what stops it rendering empty and popping in.
    const bridge = new CitationBridge();
    expect(bridge.getServerSnapshot()).toEqual(bridge.getSnapshot());
  });

  it("notifies subscribers when the conversation publishes", () => {
    const bridge = new CitationBridge();
    const listener = vi.fn();
    bridge.subscribe(listener);

    bridge.setConversation({ marks: [mark()], inks: { "doc-a": "citrine" } });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bridge.getSnapshot().marks).toHaveLength(1);
  });

  it("does NOT notify when the same references are published again", () => {
    // This is the one that matters for streaming. The conversation pane
    // publishes from an effect that runs on every render, so an answer
    // arriving a token at a time would otherwise re-render the whole reading
    // pane — virtualiser, rail and all — on every frame.
    const bridge = new CitationBridge();
    const marks = [mark()];
    const inks = { "doc-a": "citrine" } as const;

    bridge.setConversation({ marks, inks });
    const listener = vi.fn();
    bridge.subscribe(listener);

    bridge.setConversation({ marks, inks });
    bridge.setConversation({ marks, inks });
    expect(listener).not.toHaveBeenCalled();
  });

  it("returns a stable snapshot while nothing changes", () => {
    // useSyncExternalStore re-renders whenever the snapshot's identity moves,
    // so an unchanged store must return the very same object.
    const bridge = new CitationBridge();
    expect(bridge.getSnapshot()).toBe(bridge.getSnapshot());
  });

  it("activating a citation switches the document and asks for the tab", () => {
    const bridge = new CitationBridge();
    const target = mark({ documentId: "doc-b" });
    bridge.setConversation({ marks: [target], inks: {} });

    bridge.activate(target.id);

    const state = bridge.getSnapshot();
    expect(state.active?.markId).toBe(target.id);
    expect(state.activeDocumentId).toBe("doc-b");
    expect(state.tabNonce).toBe(1);
  });

  it("re-activating the same citation still counts as an activation", () => {
    // Clicking a chip you have scrolled away from must scroll back and replay
    // the wipe. The nonce is the only thing that says "this happened again".
    const bridge = new CitationBridge();
    const target = mark();
    bridge.setConversation({ marks: [target], inks: {} });

    bridge.activate(target.id);
    const first = bridge.getSnapshot().active!.nonce;
    bridge.activate(target.id);
    const second = bridge.getSnapshot().active!.nonce;

    expect(second).toBe(first + 1);
    expect(bridge.getSnapshot().tabNonce).toBe(2);
  });

  it("ignores an unknown mark id", () => {
    const bridge = new CitationBridge();
    bridge.setConversation({ marks: [mark()], inks: {} });

    bridge.activate("message-9:9");
    expect(bridge.getSnapshot().active).toBeNull();
  });

  it("keeps the highlight when a new answer arrives", () => {
    const bridge = new CitationBridge();
    const first = mark();
    bridge.setConversation({ marks: [first], inks: {} });
    bridge.activate(first.id);

    const second = mark({ messageId: "message-2", marker: 1 });
    bridge.setConversation({ marks: [first, second], inks: {} });

    expect(bridge.getSnapshot().active?.markId).toBe(first.id);
  });

  it("drops the highlight when its citation is gone", () => {
    // A regenerated answer, or a conversation switched under the pane. Leaving
    // the page lit for a citation that no longer exists would be a highlight
    // with nothing behind it.
    const bridge = new CitationBridge();
    const first = mark();
    bridge.setConversation({ marks: [first], inks: {} });
    bridge.activate(first.id);

    bridge.setConversation({
      marks: [mark({ messageId: "message-2", marker: 4 })],
      inks: {},
    });

    expect(bridge.getSnapshot().active).toBeNull();
  });

  it("clears the active citation on request, leaving the marks", () => {
    const bridge = new CitationBridge();
    const target = mark();
    bridge.setConversation({ marks: [target], inks: {} });
    bridge.activate(target.id);

    bridge.clearActive();
    expect(bridge.getSnapshot().active).toBeNull();
    expect(bridge.getSnapshot().marks).toHaveLength(1);
  });

  it("stops notifying an unsubscribed listener", () => {
    const bridge = new CitationBridge();
    const listener = vi.fn();
    const unsubscribe = bridge.subscribe(listener);

    unsubscribe();
    bridge.setConversation({ marks: [mark()], inks: {} });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("markId", () => {
  it("is the format both the chip and the rail agree on", () => {
    expect(markId("abc", 3)).toBe("abc:3");
  });
});
