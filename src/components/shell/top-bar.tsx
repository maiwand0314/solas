import { Breadcrumbs } from "./breadcrumbs";
import { CommandMenu } from "./command-menu";
import { MobileNav } from "./mobile-nav";
import { SidebarToggle } from "./sidebar-toggle";
import { Wordmark } from "./wordmark";

/**
 * The bar above every page. Desktop: sidebar toggle, breadcrumbs, search.
 * Mobile: menu button, wordmark, search icon.
 */
export function TopBar() {
  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-2 md:gap-3 md:px-3">
      <MobileNav />
      <Wordmark className="md:hidden" />

      <div className="hidden md:flex">
        <SidebarToggle />
      </div>
      <div aria-hidden="true" className="hidden h-4 w-px bg-border md:block" />
      <div className="hidden min-w-0 md:block">
        <Breadcrumbs />
      </div>

      <div className="ml-auto flex items-center">
        <CommandMenu />
      </div>
    </header>
  );
}
