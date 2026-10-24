"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import { MoreIcon, type IconProps } from "@/components/icons";
import { cn } from "@/lib/cn";

export type MenuItem = {
  label: string;
  icon?: ComponentType<IconProps>;
  onSelect: () => void;
  tone?: "default" | "danger";
  /** Draw a divider above this item. */
  separated?: boolean;
  disabled?: boolean;
};

type MenuProps = {
  /** Accessible name for the trigger and the menu, e.g. "Actions for Writer". */
  label: string;
  items: MenuItem[];
  className?: string;
};

const MENU_WIDTH = 208;
const GAP = 4;

/**
 * An actions menu (ARIA "menu button" pattern) built on the native Popover
 * API. The browser puts it in the top layer and closes it on Escape or an
 * outside click; this component adds positioning and arrow-key navigation.
 */
export function Menu({ label, items, className }: MenuProps) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return;

    // Before showing: place it under the trigger, right-aligned.
    function onBeforeToggle(event: Event) {
      if ((event as ToggleEvent).newState !== "open" || !menu || !trigger) return;
      const rect = trigger.getBoundingClientRect();
      const left = Math.min(Math.max(rect.right - MENU_WIDTH, 8), window.innerWidth - MENU_WIDTH - 8);
      menu.style.left = `${left}px`;
      menu.style.top = `${rect.bottom + GAP}px`;
    }

    // After showing: flip above the trigger if it doesn't fit, and focus the first item.
    function onToggle(event: Event) {
      if (!menu || !trigger) return;
      const isOpen = (event as ToggleEvent).newState === "open";
      setOpen(isOpen);
      if (!isOpen) return;
      const rect = trigger.getBoundingClientRect();
      if (rect.bottom + GAP + menu.offsetHeight > window.innerHeight - 8) {
        menu.style.top = `${Math.max(rect.top - GAP - menu.offsetHeight, 8)}px`;
      }
      enabledItems(menu)[0]?.focus();
    }

    menu.addEventListener("beforetoggle", onBeforeToggle);
    menu.addEventListener("toggle", onToggle);
    return () => {
      menu.removeEventListener("beforetoggle", onBeforeToggle);
      menu.removeEventListener("toggle", onToggle);
    };
  }, []);

  // A transient menu shouldn't survive navigation (Next.js keeps hidden pages mounted).
  useLayoutEffect(() => {
    const menu = menuRef.current;
    return () => {
      if (menu?.matches(":popover-open")) menu.hidePopover();
    };
  }, []);

  // A fixed-position menu would drift from its trigger on scroll; close instead.
  useEffect(() => {
    if (!open) return;
    const close = () => menuRef.current?.hidePopover();
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const menu = menuRef.current;
    if (!menu) return;
    const buttons = enabledItems(menu);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => {
      event.preventDefault();
      buttons[(next + buttons.length) % buttons.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(buttons.length - 1);
    else if (event.key === "Tab") {
      event.preventDefault();
      menu.hidePopover();
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        popoverTarget={menuId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        title="More actions"
        className={cn(
          "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors duration-100 hover:bg-surface-hover hover:text-foreground aria-expanded:bg-surface-hover aria-expanded:text-foreground",
          className,
        )}
      >
        <MoreIcon className="size-4" />
      </button>

      <div
        ref={menuRef}
        id={menuId}
        popover="auto"
        role="menu"
        aria-label={label}
        onKeyDown={onMenuKeyDown}
        style={{ width: MENU_WIDTH }}
        className="fixed inset-auto m-0 rounded-lg border border-border bg-surface-raised p-1 text-foreground shadow-popover"
      >
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label}>
              {item.separated && <div role="separator" className="-mx-1 my-1 h-px bg-border" />}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                onClick={() => {
                  menuRef.current?.hidePopover();
                  item.onSelect();
                }}
                className={cn(
                  "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-left text-sm outline-none focus-visible:bg-foreground/[0.07] hover:bg-foreground/[0.07] disabled:cursor-not-allowed disabled:opacity-50",
                  item.tone === "danger" ? "text-danger" : "text-foreground",
                )}
              >
                {Icon && <Icon className={cn("size-4 shrink-0", item.tone === "danger" ? "" : "text-subtle")} />}
                {item.label}
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

function enabledItems(menu: HTMLElement) {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
}
