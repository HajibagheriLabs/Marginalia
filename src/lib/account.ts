/**
 * The typed confirmation for "delete all my data".
 *
 * A checkbox is one click away from the button beside it, which is how an
 * irreversible action gets taken by somebody who was skimming. Typing a
 * specific word cannot happen by accident, and it makes the confirmation say
 * out loud what is about to happen — which is the actual point of asking.
 *
 * It lives in its own isomorphic module because the dialog and the Server
 * Action both need it and must agree on it, and a "use server" file may only
 * export async functions.
 */
export const DELETE_CONFIRMATION = "DELETE";
