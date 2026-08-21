"use client";

import Link from "next/link";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Shared furniture for the four auth pages. Kept here so the pages stay about
 * their flow, and so spacing and type scale can't drift between them.
 *
 * Everything is monochrome by construction — the only non-text colour allowed
 * is --danger on an error, which is a system state, not an ink.
 */

export function AuthHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-6 flex flex-col gap-1.5">
      <h1 className="text-section-title text-text">{title}</h1>
      <p className="text-body-sm text-text-muted">{description}</p>
    </div>
  );
}

/** An error from the server. States what happened; never apologises. */
export function AuthError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="mb-4 rounded-control border border-danger/40 px-3 py-2 text-body-sm text-danger"
    >
      {message}
    </p>
  );
}

/** A confirmation. Also monochrome — success is not a citation either. */
export function AuthNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-control border border-edge-strong bg-surface-raised px-3 py-2 text-body-sm text-text-muted">
      {children}
    </div>
  );
}

/**
 * A labelled input.
 *
 * The Input primitive already carries the Light Table radius, hairline, and
 * focus ring — the only thing set here is the taller 36px height these forms
 * use, since an auth field is the primary control on its page.
 */
export function AuthField({
  id,
  label,
  hint,
  className,
  ...props
}: React.ComponentProps<typeof Input> & {
  id: string;
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-body-sm text-text">
        {label}
      </Label>
      <Input
        id={id}
        className={cn("h-9", className)}
        {...props}
      />
      {hint ? <p className="text-body-sm text-text-faint">{hint}</p> : null}
    </div>
  );
}

/**
 * The primary action: --text fill, --room label. A filled monochrome button
 * reads as emphatic without reaching for an accent colour.
 */
export function AuthSubmit({
  children,
  pending,
  className,
}: {
  children: React.ReactNode;
  pending: boolean;
  className?: string;
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      className={cn(
        "focus-ring h-9 w-full rounded-control bg-text text-body font-medium text-room",
        "transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function AuthFooter({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <p className="mt-5 border-t border-edge pt-4 text-body-sm text-text-muted">
      {children}
    </p>
  );
}

/** Links are monochrome too; underline carries the affordance. */
export function AuthLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="rounded-control text-text underline underline-offset-4 hover:opacity-80"
    >
      {children}
    </Link>
  );
}
