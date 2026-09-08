import type { Metadata } from "next";

import { UsageMeter } from "@/components/limit-dialog";
import { DeleteAllData } from "@/components/settings/delete-all-data";
import { requireUser } from "@/lib/auth-server";
import { listUserConversations } from "@/lib/conversations";
import { env } from "@/lib/env";
import { UPLOAD_LIMIT_LABEL } from "@/lib/limits";
import { countUserDocuments, readLimitsReport, readMonthlyUsage } from "@/lib/usage";
import { formatBytes } from "@/lib/upload";

export const metadata: Metadata = { title: "Settings" };

/**
 * SETTINGS: what this account has used, what it is allowed, what is running,
 * and how to erase all of it.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THIS PAGE ENFORCES NOTHING.
 *
 * Every ceiling below is decided on the server, inside the transaction of the
 * write it constrains — see src/lib/limits.ts for the numbers and
 * src/lib/usage/guard.ts for where each one is applied. This page reads them
 * back and explains them. That separation is the point: a limit a user can
 * only discover by hitting it is a limit that feels arbitrary, and a limit
 * displayed by the code that enforces it is a limit that can quietly disagree
 * with itself.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * "THIS MONTH" SHOWS TOKENS AND REQUESTS, NOT A DOLLAR FIGURE.
 *
 * Because a dollar figure here would be $0.00, and it would be true. Every
 * OpenRouter model is a `:free` variant validated at boot, and embeddings are
 * computed in this Node process on this server's CPU. A "$0.00 spent" headline
 * says nothing about how much work was done and invites the reader to assume
 * it is an estimate that got rounded away.
 *
 * So the summary leads with the measurements that are real — tokens embedded,
 * tokens generated, requests made, compute time spent — and states the price
 * as a qualifier. The accounting behind it is complete, priced from a real
 * table, and would show a real number the day a paid model is configured. It
 * simply has nothing interesting to say yet, and pretending otherwise would be
 * the dishonest option.
 */
export default async function SettingsPage() {
  const user = await requireUser();

  const [limits, usage, documents, conversations] = await Promise.all([
    readLimitsReport(user.id),
    readMonthlyUsage(user.id),
    countUserDocuments(user.id),
    listUserConversations(user.id),
  ]);

  const month = new Date(usage.since).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-room">
      <header className="flex h-12 shrink-0 items-center border-b border-edge px-4">
        <h1 className="text-body font-medium text-text">Settings</h1>
      </header>

      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-10 px-5 py-10">
        {/* ── ACCOUNT ──────────────────────────────────────────────────── */}
        <section>
          <p className="label">Account</p>
          <dl className="mt-3 flex flex-col divide-y divide-edge rounded-panel border border-edge bg-surface">
            <Row term="Name">{user.name}</Row>
            <Row term="Email">{user.email}</Row>
          </dl>
        </section>

        {/* ── USAGE ────────────────────────────────────────────────────── */}
        <section>
          <p className="label">This month</p>
          <p className="mt-2 text-body-sm text-text-muted">
            Since {month}, UTC. Tokens and requests rather than a bill: every
            model in the pool is a free variant and embeddings run on this
            server, so the honest cost is nothing.
          </p>

          <div className="mt-3 grid grid-cols-1 gap-px overflow-hidden rounded-panel border border-edge bg-edge sm:grid-cols-3">
            <Stat
              label="Answers"
              value={usage.completion.events.toLocaleString("en-US")}
              detail={`${usage.completion.quantity.toLocaleString("en-US")} tokens`}
            />
            <Stat
              label="Passages embedded"
              value={usage.embedding.quantity.toLocaleString("en-US")}
              detail={`${usage.embedding.events.toLocaleString("en-US")} batches · ${formatDuration(
                usage.embedding.durationMs,
              )}`}
            />
            <Stat
              label="Uploaded"
              value={formatBytes(usage.upload.quantity)}
              detail={`${usage.upload.events.toLocaleString("en-US")} files`}
            />
          </div>

          <p className="num mt-3 text-mono-xs text-text-faint">
            $0.00 · free tier
          </p>
        </section>

        {/* ── LIMITS ───────────────────────────────────────────────────── */}
        <section>
          <p className="label">Limits</p>
          <p className="mt-2 text-body-sm text-text-muted">
            Enforced on the server. Hitting one is not an error — the app says
            which limit stopped the action and what clears it.
          </p>

          <div className="mt-3 flex flex-col divide-y divide-edge rounded-panel border border-edge bg-surface">
            {[
              limits.documents,
              limits.pages,
              limits.questions,
              limits.spend,
            ].map((limit) => (
              <div key={limit.label} className="px-4 py-3">
                <p className="text-body text-text">{limit.label}</p>
                <UsageMeter
                  className="mt-2"
                  used={limit.used}
                  limit={limit.limit}
                  unit={limit.unit}
                />
                <p className="mt-2 text-body-sm text-text-muted">{limit.note}</p>
              </div>
            ))}

            <div className="px-4 py-3">
              <p className="text-body text-text">Upload size</p>
              <p className="num mt-1 text-mono-sm text-text">
                {UPLOAD_LIMIT_LABEL}
              </p>
              <p className="mt-2 text-body-sm text-text-muted">
                Per file. Larger files are refused before the transfer starts.
              </p>
            </div>
          </div>
        </section>

        {/* ── MODELS ───────────────────────────────────────────────────── */}
        <section>
          <p className="label">Models</p>

          <dl className="mt-3 flex flex-col divide-y divide-edge rounded-panel border border-edge bg-surface">
            <Row term="Answers">
              <span className="num text-mono-sm">{env.OPENROUTER_MODEL}</span>
            </Row>
            <Row term="Fallbacks">
              <span className="num text-right text-mono-sm">
                {env.OPENROUTER_FALLBACK_MODELS.join(", ") || "none"}
              </span>
            </Row>
            <Row term="Embeddings">
              <span className="num text-mono-sm">{env.EMBEDDING_MODEL}</span>
            </Row>
            <Row term="Reranking">
              <span className="num text-mono-sm">
                {env.RETRIEVAL_RERANKER === "off"
                  ? "off"
                  : env.RETRIEVAL_RERANK_MODEL}
              </span>
            </Row>
          </dl>

          <p className="mt-3 text-body-sm text-text-muted">
            Every model id ends in <span className="num">:free</span>, which the
            app checks at startup and refuses to run without — there is no code
            path that falls back to a metered model. Free models are delisted
            without notice, so the fallbacks are tried in order and the answer
            footer names the one that actually replied.
          </p>
          <p className="mt-2 text-body-sm text-text-muted">
            Embeddings are computed locally, inside this server process, with no
            API call and no per-token cost. That is also why answers can be slow
            on a cold start: the model weights have to be loaded first.
          </p>
          <p className="mt-2 text-body-sm text-text-muted">
            The free pool allows roughly{" "}
            <span className="num">{limits.freePool.limitToday}</span> model
            requests a day across the whole app, shared by everyone using it —
            not per account. When it is spent, the app says so and names the
            reset time.
          </p>
        </section>

        {/* ── DANGER ───────────────────────────────────────────────────── */}
        <section>
          <p className="label">Your data</p>
          <div className="mt-3">
            <DeleteAllData
              documents={documents}
              conversations={conversations.length}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function Row({
  term,
  children,
}: {
  term: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-3">
      <dt className="shrink-0 text-body-sm text-text-muted">{term}</dt>
      <dd className="min-w-0 text-body break-words text-text">{children}</dd>
    </div>
  );
}

/** One measurement. The number is mono; its label and detail are not. */
function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="bg-surface px-4 py-3">
      <p className="label">{label}</p>
      <p className="num mt-1.5 text-page-title text-text">{value}</p>
      <p className="num mt-0.5 text-mono-xs text-text-faint">{detail}</p>
    </div>
  );
}

/** Compute time, in the largest unit that keeps it readable. */
function formatDuration(ms: number): string {
  if (ms === 0) return "0 s";
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}
