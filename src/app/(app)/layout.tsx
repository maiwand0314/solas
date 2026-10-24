import { Sidebar } from "@/components/shell/sidebar";
import { TopBar } from "@/components/shell/top-bar";
import { Toaster } from "@/components/ui/toast";

/**
 * The application shell, shared by every page in the (app) route group.
 * The parentheses keep "app" out of the URL: (app)/agents is served at /agents.
 */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-surface-raised focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-popover"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
          <div className="mx-auto w-full max-w-[1040px] px-4 py-8 md:px-10 md:py-12">
            {children}
          </div>
        </main>
      </div>
      <Toaster />
    </div>
  );
}
