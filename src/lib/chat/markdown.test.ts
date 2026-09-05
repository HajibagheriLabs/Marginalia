import { describe, expect, it } from "vitest";

import {
  parseInline,
  parseMarkdown,
  safeHref,
  stripInvalidMarkers,
  type Block,
  type Inline,
} from "./markdown";

/**
 * THE ANSWER GRAMMAR, tested as pure functions.
 *
 * The parser exists because citation markers are part of the grammar and
 * because a library would bring a colour palette with it. Both of those are
 * assertions about specific inputs, which is what this file is: the cases that
 * would silently corrupt an answer if the regexes were tuned wrong.
 */

/** Flatten an inline tree to `kind:value` pairs, for readable assertions. */
function shape(nodes: Inline[]): string[] {
  return nodes.map((node) => {
    switch (node.kind) {
      case "text":
        return `text:${node.value}`;
      case "code":
        return `code:${node.value}`;
      case "marker":
        return `marker:${node.marker}`;
      case "link":
        return `link:${node.href}:${shape(node.children).join("|")}`;
      default:
        return `${node.kind}:${shape(node.children).join("|")}`;
    }
  });
}

describe("parseInline", () => {
  it("turns a citation marker into its own node", () => {
    expect(shape(parseInline("The notice period is 30 days [2]."))).toEqual([
      "text:The notice period is 30 days ",
      "marker:2",
      "text:.",
    ]);
  });

  it("keeps several markers on one claim separate", () => {
    expect(shape(parseInline("Both apply [2][5]."))).toEqual([
      "text:Both apply ",
      "marker:2",
      "marker:5",
      "text:.",
    ]);
  });

  it("does not read a markdown link as a marker", () => {
    // `[1](https://example.com)` is a link whose text happens to be a digit.
    // If the marker branch ran first it would eat the `[1]` and leave a bare
    // `(https://example.com)` in the prose.
    expect(shape(parseInline("See [1](https://example.com)."))).toEqual([
      "text:See ",
      "link:https://example.com:text:1",
      "text:.",
    ]);
  });

  it("does not treat a leading zero as a marker", () => {
    // The model was never given `[01]`, so treating it as valid would invent a
    // mapping. It stays literal text.
    expect(shape(parseInline("Clause [01] applies."))).toEqual([
      "text:Clause [01] applies.",
    ]);
  });

  it("quarantines everything inside a code span", () => {
    expect(shape(parseInline("Set `**bold** [3]` in config."))).toEqual([
      "text:Set ",
      "code:**bold** [3]",
      "text: in config.",
    ]);
  });

  it("prefers strong over emphasis", () => {
    expect(shape(parseInline("**very** and *quite*"))).toEqual([
      "strong:text:very",
      "text: and ",
      "em:text:quite",
    ]);
  });

  it("leaves underscores alone", () => {
    // Identifiers and part numbers are everywhere in these documents, and
    // italicising the middle of one silently corrupts a quoted term.
    expect(shape(parseInline("The column is char_start_offset here."))).toEqual([
      "text:The column is char_start_offset here.",
    ]);
  });

  it("refuses a dangerous href without deleting the text", () => {
    const nodes = parseInline("[click](javascript:alert(1))");
    expect(nodes.every((node) => node.kind !== "link")).toBe(true);
    expect(shape(nodes)).toEqual(["text:[click](javascript:alert(1))"]);
  });
});

describe("safeHref", () => {
  it("allows http, https, mailto, and same-document references", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("http://example.com")).toBe("http://example.com");
    expect(safeHref("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(safeHref("/app/documents/1")).toBe("/app/documents/1");
    expect(safeHref("#section-3")).toBe("#section-3");
  });

  it("refuses every executable scheme, however it is spelled", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHref("  javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>")).toBeNull();
    expect(safeHref("vbscript:msgbox")).toBeNull();
  });
});

describe("parseMarkdown", () => {
  it("joins a hard-wrapped paragraph into one block", () => {
    const blocks = parseMarkdown("The party may\nterminate on notice [1].");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("paragraph");
  });

  it("splits paragraphs on a blank line", () => {
    expect(parseMarkdown("One.\n\nTwo.").map((b) => b.kind)).toEqual([
      "paragraph",
      "paragraph",
    ]);
  });

  it("reads an unordered list", () => {
    const [block] = parseMarkdown("- first [1]\n- second\n- third");
    expect(block.kind).toBe("list");
    if (block.kind !== "list") throw new Error("expected a list");
    expect(block.ordered).toBe(false);
    expect(block.items).toHaveLength(3);
    expect(shape(block.items[0].inline)).toEqual(["text:first ", "marker:1"]);
  });

  it("reads an ordered list and keeps its starting number", () => {
    const [block] = parseMarkdown("3. third\n4. fourth");
    if (block.kind !== "list") throw new Error("expected a list");
    expect(block.ordered).toBe(true);
    expect(block.start).toBe(3);
  });

  it("hangs a nested list under the item that opened it", () => {
    const [block] = parseMarkdown("- outer\n  - inner\n- second");
    if (block.kind !== "list") throw new Error("expected a list");
    expect(block.items).toHaveLength(2);
    expect(block.items[0].children.map((child) => child.kind)).toEqual(["list"]);
  });

  it("reads a pipe table with alignment", () => {
    const [block] = parseMarkdown(
      "| Term | Days |\n| :--- | ---: |\n| Notice | 30 [1] |",
    );
    if (block.kind !== "table") throw new Error("expected a table");
    expect(block.align).toEqual(["left", "right"]);
    expect(block.head).toHaveLength(2);
    expect(block.rows).toHaveLength(1);
    expect(shape(block.rows[0][1])).toEqual(["text:30 ", "marker:1"]);
  });

  it("does not mistake a rule for a table delimiter", () => {
    expect(parseMarkdown("---").map((b) => b.kind)).toEqual(["rule"]);
  });

  it("closes an unterminated fence, because the stream may not have finished", () => {
    const [block] = parseMarkdown("```sql\nselect 1");
    expect(block.kind).toBe("code");
    if (block.kind !== "code") throw new Error("expected code");
    expect(block.language).toBe("sql");
    expect(block.value).toBe("select 1");
  });

  it("reads a blockquote as blocks, not as text", () => {
    const [block] = parseMarkdown("> quoted **claim** [2]");
    if (block.kind !== "quote") throw new Error("expected a quote");
    expect(block.blocks.map((child: Block) => child.kind)).toEqual(["paragraph"]);
  });

  it("survives an empty answer", () => {
    expect(parseMarkdown("")).toEqual([]);
  });
});

describe("stripInvalidMarkers", () => {
  it("removes an invented marker and the space it leaves behind", () => {
    expect(
      stripInvalidMarkers("The term is five years [9]. The rest holds [1].", [9]),
    ).toBe("The term is five years. The rest holds [1].");
  });

  it("leaves the text untouched when nothing was invented", () => {
    const text = "Payment is due in 30 days [1].";
    expect(stripInvalidMarkers(text, [])).toBe(text);
  });

  it("removes every occurrence of the same invented marker", () => {
    expect(stripInvalidMarkers("A [7] and B [7] and C [2].", [7])).toBe(
      "A and B and C [2].",
    );
  });
});
