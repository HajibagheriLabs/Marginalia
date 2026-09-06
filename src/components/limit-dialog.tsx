"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LimitNotice } from "@/lib/limits";

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ A LIMIT IS A DIALOG, NOT A TOAST.                                        │
 * │                                                                          │
 * │ A toast is for something that happened and is over: the file uploaded,   │
 * │ the document was deleted. It appears, it is not read, it disappears, and │
 * │ nothing is lost — which is exactly why it is the wrong shape for a       │
 * │ limit. Hitting a ceiling is not an event that passed; it is a state the  │
 * │ account is in, and it will still be true in five minutes. A toast that   │
 * │ says "Document limit reached" leaves someone clicking Upload again and   │
 * │ watching nothing happen.                                                 │
 * │                                                                          │
 * │ So this stops the interface and says three things, in this order:        │
 * │                                                                          │
 * │   WHAT the limit is        "Document limit reached"                      │
 * │   WHERE the account stands "25 / 25 documents", in the mono face         │
 * │   WHAT TO DO               "Delete a document to upload another."        │
 * │                                                                          │
 * │ The third line is the one that matters and it is never "try again        │
 * │ later" on its own. Every notice in src/lib/limits.ts is written to have  │
 * │ a real next step, including the ones that clear by themselves — those    │
 * │ name the time they clear at.                                             │
 * │                                                                          │
 * │ NOTHING HERE ENFORCES ANYTHING. Every number rendered below was decided  │
 * │ on the server, inside the transaction of the write it constrained. This  │
 * │ component only explains.                                                 │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

interface LimitContextValue {
  /** Open the dialog for a notice the server returned. */
  showLimit: (notice: LimitNotice) => void;
}

const LimitContext = createContext<LimitContextValue | null>(null);

export function useLimitDialog(): LimitContextValue {
  const context = useContext(LimitContext);
  if (!context) {
    throw new Error("useLimitDialog must be used inside <LimitProvider>");
  }
  return context;
}

/**
 * One dialog for the whole workspace.
 *
 * It lives in the /app layout, above the panes that swap, so an upload that is
 * refused while the user is reading a different document still reports itself
 * — and so two components cannot open two competing dialogs. A second notice
 * arriving while one is open replaces it, because the newer refusal is the one
 * the user just caused.
 */
export function LimitProvider({ children }: { children: React.ReactNode }) {
  const [notice, setNotice] = useState<LimitNotice | null>(null);

  const showLimit = useCallback((next: LimitNotice) => setNotice(next), []);
  const value = useMemo<LimitContextValue>(() => ({ showLimit }), [showLimit]);

  return (
    <LimitContext.Provider value={value}>
      {children}
      <LimitDialog
        notice={notice}
        onOpenChange={(open) => {
          if (!open) setNotice(null);
        }}
      />
    </LimitContext.Provider>
  );
}

export function LimitDialog({
  notice,
  onOpenChange,
}: {
  notice: LimitNotice | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={notice !== null} onOpenChange={onOpenChange}>
      <DialogContent showClose={false}>
        <DialogHeader>
          <DialogTitle>{notice?.title}</DialogTitle>
          <DialogDescription>{notice?.message}</DialogDescription>
        </DialogHeader>

        {/* The meter is drawn only for a limit that HAS a count. A rate limit
            and an exhausted model pool are about time, not about a quantity
            the user is holding, and a bar pinned at 100% would say nothing. */}
        {notice && notice.limit > 0 && notice.key !== "rate" ? (
          <UsageMeter
            used={notice.current}
            limit={notice.limit}
            unit={notice.unit}
          />
        ) : null}

        <p className="text-body-sm text-text">{notice?.nextStep}</p>

        <DialogFooter>
          <DialogClose asChild>
            <Button size="lg">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "25 / 25 documents", with a bar.
 *
 * The bar is `--text`, like every other progress indicator in this
 * application. It is chrome: colour in this design system means a citation,
 * and a red quota bar would be the most saturated thing on screen pointing at
 * a file count. The one deviation is the `--warn` tint at or past the ceiling,
 * which is a SYSTEM STATE and is allowed to be — it is deliberately amber
 * rather than citrine so it can never be mistaken for a highlighter ink.
 */
export function UsageMeter({
  used,
  limit,
  unit,
  className,
}: {
  used: number;
  limit: number;
  unit: string;
  className?: string;
}) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const full = used >= limit;

  return (
    <div className={className}>
      <div className="num flex items-baseline justify-between text-mono-sm text-text">
        <span>
          {used.toLocaleString("en-US")} / {limit.toLocaleString("en-US")}
        </span>
        <span className="text-text-faint">{unit}</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${unit} used`}
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={limit}
        className="mt-1.5 h-0.5 w-full overflow-hidden rounded-chip bg-edge-strong"
      >
        <div
          className={full ? "h-full bg-warn" : "h-full bg-text"}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}
