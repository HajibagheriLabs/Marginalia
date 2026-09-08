import { buildPdf } from "../../src/lib/ingest/__fixtures__/build-pdf";

/**
 * THE DOCUMENT THE END-TO-END SUITE ASKS ABOUT.
 *
 * A real PDF, built by the same writer the extraction tests use, so the bytes
 * the pipeline parses are genuinely a PDF and not a text file with a helpful
 * extension. Small on purpose: two pages is enough for a citation to point at
 * page 2 and prove the viewer scrolled somewhere, and CI has a six-minute
 * budget that a fifty-page fixture would spend on embedding.
 *
 * The clause on page 2 is the one the question is about. It is worded so that
 * the answer is unambiguous — "thirty (30) days" appears nowhere else — which
 * is what lets the test assert that the citation landed on the right passage
 * rather than merely on a passage.
 */

export const E2E_DOCUMENT = {
  title: "E2E Services Agreement",
  filename: "e2e-services-agreement.pdf",
  /** The question the browser test types. */
  question: "How much notice is required to terminate the agreement?",
  /** A phrase that appears only in the passage that answers it. */
  answeringPhrase: "thirty (30) days",
} as const;

function paragraph(lines: string[]): string[] {
  return lines;
}

export function buildE2ePdf(): Buffer {
  const bytes = buildPdf([
    {
      blocks: [
        {
          x: 60,
          y: 760,
          lines: paragraph([
            "MASTER SERVICES AGREEMENT",
            "",
            "1. Services. The Provider shall perform the services described in",
            "each Statement of Work with reasonable skill and care, and shall",
            "notify the Customer in writing of any delay affecting an agreed",
            "delivery date.",
            "",
            "2. Fees. The Customer shall pay the fees set out in the applicable",
            "Statement of Work within thirty days of receipt of a valid invoice.",
            "Disputed amounts shall be notified in writing before the due date.",
            "",
            "3. Confidentiality. Each party shall keep confidential all",
            "information disclosed by the other party in connection with this",
            "agreement, and shall not disclose it to any third party without",
            "prior written consent.",
          ]),
        },
      ],
    },
    {
      blocks: [
        {
          x: 60,
          y: 760,
          lines: paragraph([
            "ARTICLE 7 - TERMINATION",
            "",
            "7.1 Termination for convenience. Either party may terminate this",
            "agreement for convenience by giving thirty (30) days prior written",
            "notice to the other party. Termination shall not relieve either",
            "party of obligations accrued before the effective date.",
            "",
            "7.2 Termination for cause. Either party may terminate this",
            "agreement immediately on written notice if the other party commits",
            "a material breach that is not remedied within fifteen days of",
            "written notice requiring the breach to be remedied.",
            "",
            "7.3 Effect of termination. On termination the Provider shall",
            "deliver all work product completed to the effective date, and the",
            "Customer shall pay for services performed to that date.",
          ]),
        },
      ],
    },
  ]);

  return Buffer.from(bytes);
}
