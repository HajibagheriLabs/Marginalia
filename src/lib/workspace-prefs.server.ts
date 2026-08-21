import { cookies } from "next/headers";

import {
  CONVERSATION_WIDTH_COOKIE,
  RAIL_COOKIE,
  parseConversationWidth,
  parseRailCollapsed,
} from "./workspace-prefs";

/**
 * Read the persisted layout preferences on the server, so the shell's first
 * paint already has the remembered rail state and conversation width. Kept in
 * its own file because the module beside it is imported by client components
 * and must not pull in `next/headers`.
 */
export async function readWorkspacePrefs() {
  const store = await cookies();
  return {
    railCollapsed: parseRailCollapsed(store.get(RAIL_COOKIE)?.value),
    conversationWidth: parseConversationWidth(
      store.get(CONVERSATION_WIDTH_COOKIE)?.value,
    ),
  };
}
