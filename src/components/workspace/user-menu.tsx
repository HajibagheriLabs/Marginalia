"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronsUpDown, LogOut, Moon, Settings, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

/**
 * The bottom of the library rail: who you are, and the three things you can do
 * about it.
 *
 * The theme switch lives here rather than in a corner of its own. Switching the
 * room from dark to light is a preference about your workspace, and it sits
 * next to the other preferences instead of being a permanently visible control
 * competing with the document list.
 */
export function UserMenu({
  name,
  email,
  collapsed = false,
}: {
  name: string;
  email: string;
  collapsed?: boolean;
}) {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [signingOut, setSigningOut] = useState(false);

  const initial = (name || email).slice(0, 1).toUpperCase();

  async function handleSignOut() {
    setSigningOut(true);
    await signOut();
    router.push("/sign-in");
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex items-center gap-2 rounded-control text-left",
          "hover:bg-surface-raised aria-expanded:bg-surface-raised",
          collapsed ? "size-8 justify-center" : "w-full px-2 py-1.5",
        )}
        aria-label={`Account: ${name || email}`}
      >
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-chip border border-edge-strong bg-surface-raised text-[11px] font-semibold text-text-muted"
        >
          {initial}
        </span>
        {collapsed ? null : (
          <>
            <span className="min-w-0 flex-1 truncate text-body-sm text-text">
              {name || email}
            </span>
            <ChevronsUpDown
              aria-hidden
              className="size-3.5 shrink-0 text-text-faint"
            />
          </>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-[236px]">
        <DropdownMenuLabel>
          <span className="block truncate text-body-sm text-text">{name}</span>
          <span className="block truncate text-[11px] leading-4 text-text-faint">
            {email}
          </span>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link href="/app/settings">
            <Settings aria-hidden />
            Settings
          </Link>
        </DropdownMenuItem>

        {/*
          Which label shows is decided in CSS from the theme class on <html>,
          not from React state — next-themes writes that class before first
          paint, so this renders correctly on the server and never flashes the
          wrong word. `onSelect` is prevented so the menu stays open and you can
          see the room change behind it.
        */}
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            setTheme(resolvedTheme === "light" ? "dark" : "light");
          }}
        >
          <Sun aria-hidden className="hidden dark:block" />
          <Moon aria-hidden className="block dark:hidden" />
          <span className="hidden dark:inline">Light room</span>
          <span className="inline dark:hidden">Dark room</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          variant="danger"
          disabled={signingOut}
          onSelect={(event) => {
            event.preventDefault();
            void handleSignOut();
          }}
        >
          <LogOut aria-hidden />
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
