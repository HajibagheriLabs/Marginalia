import { cn } from "@/lib/utils";

/**
 * A turn in the conversation.
 *
 * The two roles are NOT symmetrical, and the asymmetry is the point:
 *
 *  - A USER message is a short thing you wrote. It gets a --surface container
 *    so you can find it while scrolling back — it is a landmark, not content.
 *  - An ASSISTANT message is a grounded answer with citations in it, and it is
 *    the thing you are actually here to read. It gets NO container: plain text
 *    on --room at a comfortable measure. Wrapping a long answer in a bubble
 *    would narrow it, box it, and make it look like chat rather than a written
 *    response with sources.
 *
 * Nothing here is coloured. The only colour that will ever appear inside an
 * assistant message is a citation chip.
 */
export function MessageBubble({
  role,
  children,
  className,
}: {
  role: "user" | "assistant";
  children: React.ReactNode;
  className?: string;
}) {
  if (role === "user") {
    return (
      <div className={cn("flex justify-end", className)}>
        <div
          data-role="user"
          className="max-w-[85%] rounded-panel bg-surface px-3 py-2 text-body whitespace-pre-wrap text-text"
        >
          {children}
        </div>
      </div>
    );
  }

  return (
    <div
      data-role="assistant"
      className={cn("measure text-body text-text", className)}
    >
      {children}
    </div>
  );
}
