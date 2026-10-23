"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import {
  MonitorIcon,
  MoonIcon,
  SearchIcon,
  SidebarIcon,
  SunIcon,
  type IconProps,
} from "@/components/icons";
import { toggleSidebar } from "@/components/preferences/sidebar-store";
import { setThemePreference, useThemePreference } from "@/components/preferences/theme-store";
import { IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/cn";
import { allNavItems, isActivePath } from "./nav-items";

type Command = {
  id: string;
  group: "Go to" | "Theme" | "Layout";
  label: string;
  icon: ComponentType<IconProps>;
  /** Shown on the right, e.g. "Current". */
  hint?: string;
  run: () => void;
};

/**
 * Search-and-jump menu, opened with ⌘K / Ctrl+K or the top bar button.
 *
 * Accessibility follows the ARIA combobox pattern: focus stays in the input,
 * arrow keys move a highlighted option (announced via aria-activedescendant),
 * Enter runs it, and Escape closes the dialog.
 */
export function CommandMenu() {
  const router = useRouter();
  const pathname = usePathname();
  const theme = useThemePreference();
  const listboxId = useId();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const commands = useMemo(() => {
    const currentHint = (isCurrent: boolean) => (isCurrent ? "Current" : undefined);
    const list: Command[] = [
      ...allNavItems.map((item): Command => ({
        id: `go-${item.href}`,
        group: "Go to",
        label: item.label,
        icon: item.icon,
        hint: currentHint(isActivePath(pathname, item.href)),
        run: () => router.push(item.href),
      })),
      { id: "theme-light", group: "Theme", label: "Light", icon: SunIcon, hint: currentHint(theme === "light"), run: () => setThemePreference("light") },
      { id: "theme-dark", group: "Theme", label: "Dark", icon: MoonIcon, hint: currentHint(theme === "dark"), run: () => setThemePreference("dark") },
      { id: "theme-system", group: "Theme", label: "System", icon: MonitorIcon, hint: currentHint(theme === "system"), run: () => setThemePreference("system") },
      { id: "toggle-sidebar", group: "Layout", label: "Toggle sidebar", icon: SidebarIcon, hint: "[", run: toggleSidebar },
    ];
    return list;
  }, [pathname, router, theme]);

  const normalizedQuery = query.trim().toLowerCase();
  const results = normalizedQuery
    ? commands.filter((command) =>
        `${command.group} ${command.label}`.toLowerCase().includes(normalizedQuery),
      )
    : commands;
  const active = Math.min(activeIndex, results.length - 1);
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  // Every way of closing (Escape, backdrop, running a command) ends here, so
  // the menu always reopens with an empty search.
  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next) {
      setQuery("");
      setActiveIndex(0);
    }
  }

  // ⌘K / Ctrl+K toggles the menu from anywhere, including inside text fields.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setOpen((current) => !current);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Keep the highlighted option visible while moving through a long list.
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  });

  function runCommand(command: Command) {
    changeOpen(false);
    command.run();
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((active + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((active - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runCommand(results[active]);
    }
  }

  return (
    <>
      {/* Wide trigger on desktop, icon-only on small screens. */}
      <span className="hidden md:block">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-keyshortcuts="Meta+K Control+K"
          className="flex h-8 w-60 cursor-pointer items-center justify-between rounded-md border border-border-strong bg-surface pr-1.5 pl-2.5 text-sm text-subtle shadow-control transition-colors duration-100 hover:bg-surface-hover hover:text-muted"
        >
          <span className="flex items-center gap-2">
            <SearchIcon className="size-4" />
            Search or jump to…
          </span>
          <Kbd>⌘K</Kbd>
        </button>
      </span>
      <span className="md:hidden">
        <IconButton label="Search" shortcut="⌘K" onClick={() => setOpen(true)} aria-haspopup="dialog">
          <SearchIcon className="size-4" />
        </IconButton>
      </span>

      <Dialog
        open={open}
        onOpenChange={changeOpen}
        aria-label="Command menu"
        className="mx-auto mt-[12vh] mb-auto w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-surface-raised shadow-popover open:animate-dialog-in"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3.5">
          <SearchIcon className="size-4 shrink-0 text-subtle" />
          <Input
            variant="bare"
            role="combobox"
            aria-label="Search commands"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={results.length > 0 ? optionId(active) : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder="Search or jump to…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onInputKeyDown}
            className="h-12"
          />
          <Kbd>Esc</Kbd>
        </div>

        <ul id={listboxId} role="listbox" aria-label="Commands" className="max-h-80 overflow-y-auto p-1.5">
          {results.map((command, index) => {
            const Icon = command.icon;
            const showGroup = index === 0 || results[index - 1].group !== command.group;
            return (
              <li key={command.id} role="presentation">
                {showGroup && (
                  <div aria-hidden="true" className="px-2.5 pt-2.5 pb-1 text-xs font-medium text-subtle">
                    {command.group}
                  </div>
                )}
                <div
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  aria-label={`${command.group}: ${command.label}`}
                  tabIndex={-1}
                  // Keep focus in the input while clicking an option.
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerMove={() => index !== active && setActiveIndex(index)}
                  onClick={() => runCommand(command)}
                  className={cn(
                    "flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm",
                    index === active ? "bg-foreground/[0.07] text-foreground" : "text-muted",
                  )}
                >
                  <Icon className="size-4 shrink-0 text-subtle" />
                  <span className="flex-1 truncate">{command.label}</span>
                  {command.hint && <span className="text-xs text-subtle">{command.hint}</span>}
                </div>
              </li>
            );
          })}
        </ul>

        {results.length === 0 && (
          <p className="px-4 pt-2 pb-8 text-center text-sm text-muted">
            Nothing matches “{query.trim()}”.
          </p>
        )}

        {/* Keyboard hints; not useful on touch screens. */}
        <div className="hidden items-center gap-4 border-t border-border px-3.5 py-2 text-xs text-subtle md:flex">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            to move
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
            to select
          </span>
        </div>
      </Dialog>
    </>
  );
}
