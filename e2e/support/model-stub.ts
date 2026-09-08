import { createServer, type Server } from "node:http";

/**
 * A STAND-IN FOR THE MODEL GATEWAY.
 *
 * The end-to-end suite has to be deterministic and free, and a real free model
 * is neither. It shares a 50-requests-per-day pool with everything else this
 * account does, it is delisted without notice, and it writes a different answer
 * every time — so a suite that asserted on a real completion would be a
 * weather report: red on a busy afternoon, green on a quiet one, and never
 * evidence about this application.
 *
 * So the app points at this instead, through `OPENROUTER_BASE_URL`. Everything
 * up to and including `streamText` is the shipping code path; only the socket
 * on the far end is different. That is the seam worth mocking — mocking the AI
 * SDK would assert that this project calls the functions it calls.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * IT ANSWERS WITH MARKERS IT WAS GIVEN
 *
 * The answer is not a fixed string. The stub reads the numbered passages out of
 * the prompt the app actually built and cites the first one, so the citation
 * the browser test clicks is a citation to a passage that was really retrieved
 * for that question. A hard-coded "[1]" would still render a chip, and would
 * still pass, while proving nothing about whether retrieval and generation
 * agree on what passage 1 is.
 *
 * It also emits ONE MARKER THAT DOES NOT EXIST — a high number, deliberately —
 * so the same run exercises the validation path that strips invented markers.
 * That is the P2 property, asserted in the browser rather than only in a unit
 * test: an invented citation must never reach the page.
 */

/*
 * FIXED PORTS, NOT EPHEMERAL ONES.
 *
 * Playwright may start `webServer` before `globalSetup` runs, so the app's
 * OPENROUTER_BASE_URL has to be knowable before either of them exists. An
 * ephemeral port would only be known after the stub had already started, which
 * is too late. The stub is listening well before the first chat request, which
 * is all the ordering that actually matters.
 */
export const MODEL_STUB_PORT = Number(process.env.E2E_MODEL_STUB_PORT ?? 3101);
export const FIXTURE_PORT = Number(process.env.E2E_FIXTURE_PORT ?? 3102);

/** The base URL the app is pointed at. The AI SDK appends /chat/completions. */
export function modelStubUrl(port = MODEL_STUB_PORT): string {
  return `http://127.0.0.1:${port}/api/v1`;
}

export interface ModelStub {
  url: string;
  /** Every prompt the app sent, for assertions about what the model was shown. */
  prompts: string[];
  close(): Promise<void>;
}

/**
 * ARMING A MID-STREAM FAILURE.
 *
 * The AI SDK does not throw provider errors out of the stream iterator: it
 * yields an `{type:"error"}` part and then COMPLETES NORMALLY. A caller that
 * only wraps `textStream` in try/catch therefore sees a short, cheerful,
 * truncated answer and no error at all — which reaches the reader as a stall
 * with half a sentence on screen and no way to tell whether more is coming.
 *
 * The failure is armed OUT OF BAND, by POSTing to this path, rather than by a
 * trigger phrase inside the question. The first attempt did use a phrase, and
 * it never reached the stub at all: the extra words dragged the query's
 * embedding far enough that nothing cleared the relevance floor, so the app
 * correctly answered "nothing in this document covers that" WITHOUT calling a
 * model. The test passed through a path it was not testing.
 *
 * A control channel keeps the question realistic — the same one the happy path
 * asks, which is known to retrieve — and makes the failure deterministic
 * instead of dependent on how a sentence embeds.
 */
export const STUB_CONTROL_PATH = "/__control/fail-next-stream";

/** `[3]` etc., as `buildContext` numbers the passages it hands over. */
function markersInPrompt(prompt: string): number[] {
  const found = new Set<number>();
  for (const match of prompt.matchAll(/\[(\d{1,3})\]/g)) {
    found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * One SSE frame in the OpenAI chat-completions streaming shape, which is what
 * OpenRouter speaks and what the AI SDK's OpenAI-compatible provider parses.
 */
function chunk(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "e2e/stub",
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`;
}

export async function startModelStub(port: number): Promise<ModelStub> {
  const prompts: string[] = [];
  /** Armed by the control path, and spent by the next completion. */
  let failNextStream = false;

  const server = createServer((request, response) => {
    if (request.url?.startsWith(STUB_CONTROL_PATH)) {
      failNextStream = true;
      response.writeHead(200, { "Content-Type": "text/plain" }).end("armed");
      return;
    }

    if (!request.url?.includes("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }

    let body = "";
    request.on("data", (piece) => (body += piece));
    request.on("end", () => {
      let sentence = "The stub could not read the passages it was given.";
      // Read and cleared here, so one arming produces exactly one failure.
      const failMidStream = failNextStream;
      failNextStream = false;

      try {
        const parsed = JSON.parse(body) as {
          messages?: Array<{ role: string; content: unknown }>;
        };
        const text = (parsed.messages ?? [])
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content),
          )
          .join("\n");
        prompts.push(text);

        const markers = markersInPrompt(text);
        const first = markers[0] ?? 1;
        // One real marker and one invented one, in a single answer. The chip
        // for `first` must render; the invented one must be stripped and
        // logged before the answer is persisted.
        const invented = (markers.at(-1) ?? 1) + 40;
        sentence =
          `Either party may terminate the agreement on thirty days written ` +
          `notice [${first}]. This sentence carries an invented marker ` +
          `[${invented}] that must never reach the page.`;
      } catch {
        // Fall through with the default sentence; the assertion will say so.
      }

      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Word by word, so the client's streaming path is exercised rather than
      // a single-chunk special case that would hide a buffering bug.
      response.write(chunk({ role: "assistant", content: "" }));

      if (failMidStream) {
        // Enough text to prove the stream really started, then an upstream
        // error in the shape OpenRouter sends one. The app must surface this,
        // not silently stop.
        response.write(chunk({ content: "Either party may " }));
        response.write(
          `data: ${JSON.stringify({
            error: {
              message: "upstream model dropped the connection",
              type: "server_error",
              code: 502,
            },
          })}

`,
        );
        response.end();
        return;
      }

      for (const word of sentence.split(" ")) {
        response.write(chunk({ content: `${word} ` }));
      }

      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "e2e/stub",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 900, completion_tokens: 32, total_tokens: 932 },
        })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    // The AI SDK appends `/chat/completions` to this.
    url: modelStubUrl(port),
    prompts,
    close: () => closeServer(server),
  };
}

/**
 * A static file server for the ingestion fixture.
 *
 * Extraction fetches `documents.blob_url`, and in production that is Vercel
 * Blob. CI has no Blob token, so the fixture is served from here instead and
 * the URL is stored on the row exactly as an uploaded file's would be. The
 * pipeline does not know the difference — it fetches a URL and parses bytes —
 * which is the point: extraction, chunking, embedding and indexing all run for
 * real against a real file.
 */
export async function startFixtureServer(
  port: number,
  files: Record<string, { body: Buffer; contentType: string }>,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    /*
     * CORS, because the BROWSER fetches this file too.
     *
     * The viewer renders a PDF client-side from `documents.blob_url`, so the
     * page at :3100 asks :3102 for the bytes — a cross-origin request. Vercel
     * Blob serves with permissive CORS in production; without the same headers
     * here the fetch is blocked and the reading pane shows "This document could
     * not be displayed", with the server logs showing nothing wrong at all.
     */
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      // PDF.js asks for byte ranges; without this it silently refetches whole.
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    };

    if (request.method === "OPTIONS") {
      response.writeHead(204, cors).end();
      return;
    }

    const name = (request.url ?? "").replace(/^\//, "").split("?")[0];
    const file = files[name];
    if (!file) {
      response.writeHead(404, cors).end();
      return;
    }
    response.writeHead(200, {
      ...cors,
      "Content-Type": file.contentType,
      "Content-Length": String(file.body.byteLength),
      "Accept-Ranges": "none",
    });
    response.end(file.body);
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
