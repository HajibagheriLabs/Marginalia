import { env } from "./env";
import { APP_NAME } from "./brand";

/**
 * Transactional email.
 *
 * This is a seam, not an implementation. Marginalia only ever sends two
 * messages — verify your address, and reset your password — so the interface
 * stays deliberately small.
 *
 * There is no email provider configured yet. The console sender writes the
 * message to the server log instead, which is enough to complete both flows in
 * development: the verification and reset links are printed and can be pasted
 * into the browser.
 *
 * To send real mail, implement `EmailSender` against a provider (Resend,
 * Postmark, SES) and return it from `createEmailSender()`. Nothing else in the
 * codebase needs to change.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text body. Both current messages are plain text by design. */
  body: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Writes the message to the server log. Used until a provider is wired up.
 * The link is printed on its own line so it is easy to find and click.
 */
const consoleSender: EmailSender = {
  async send({ to, subject, body }) {
    console.info(
      [
        "",
        `─── ${APP_NAME} email (not sent — no provider configured) ───`,
        `To:      ${to}`,
        `Subject: ${subject}`,
        "",
        body,
        "─".repeat(60),
        "",
      ].join("\n"),
    );
  },
};

function createEmailSender(): EmailSender {
  // When a provider is added, branch on its env var here and fall back to the
  // console sender so local development never needs credentials.
  return consoleSender;
}

export const email: EmailSender = createEmailSender();

/** True when mail is only being logged, so the UI can say so honestly. */
export const emailIsSimulated = true;

export function verificationEmail(url: string): Omit<EmailMessage, "to"> {
  return {
    subject: `Verify your ${APP_NAME} address`,
    body: [
      `Confirm this address to finish setting up your ${APP_NAME} account.`,
      "",
      url,
      "",
      "The link expires in one hour. If you didn't create an account, ignore this message.",
    ].join("\n"),
  };
}

export function passwordResetEmail(url: string): Omit<EmailMessage, "to"> {
  return {
    subject: `Reset your ${APP_NAME} password`,
    body: [
      "Use this link to choose a new password.",
      "",
      url,
      "",
      "The link expires in one hour. If you didn't ask for a reset, ignore this message and your password stays as it is.",
    ].join("\n"),
  };
}

/** Exposed so the auth config can build absolute URLs consistently. */
export const appUrl = () => env.BETTER_AUTH_URL;
