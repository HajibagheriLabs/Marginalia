/**
 * Persisted workspace layout preferences.
 *
 * These live in COOKIES rather than localStorage on purpose. The shell is
 * server-rendered, so the rail width and the conversation pane width have to be
 * known before the first paint — reading them from localStorage in an effect
 * would render the default layout, then jump. A cookie is sent with the
 * document request, so the server emits the user's actual layout the first
 * time. Same reasoning as next-themes writing the theme class pre-hydration.
 *
 * Nothing here is security-relevant: these are display preferences, they are
 * read back through `clamp`/`parse` helpers, and a hostile value can at worst
 * give its own browser an odd pane width.
 */

export const RAIL_COOKIE = "marginalia.rail";
export const CONVERSATION_WIDTH_COOKIE = "marginalia.conversation_width";

/** One year. These are preferences; they should outlive the session. */
export const PREF_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** The library rail: 240px expanded, 56px as an icon rail. */
export const RAIL_WIDTH = 240;
export const RAIL_WIDTH_COLLAPSED = 56;

/** The conversation pane is resizable inside these bounds. */
export const CONVERSATION_MIN_WIDTH = 400;
export const CONVERSATION_MAX_WIDTH = 520;
export const CONVERSATION_DEFAULT_WIDTH = 440;

export function clampConversationWidth(width: number): number {
  if (!Number.isFinite(width)) return CONVERSATION_DEFAULT_WIDTH;
  return Math.min(
    CONVERSATION_MAX_WIDTH,
    Math.max(CONVERSATION_MIN_WIDTH, Math.round(width)),
  );
}

/** Parse the cookie value, falling back to the default on anything unexpected. */
export function parseConversationWidth(raw: string | undefined): number {
  if (!raw) return CONVERSATION_DEFAULT_WIDTH;
  return clampConversationWidth(Number.parseInt(raw, 10));
}

export function parseRailCollapsed(raw: string | undefined): boolean {
  return raw === "collapsed";
}

/**
 * Write a preference cookie from the browser. Deliberately not HttpOnly — the
 * client owns these values and the server only reads them to avoid a flash.
 */
export function writePrefCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${PREF_COOKIE_MAX_AGE}; samesite=lax`;
}
