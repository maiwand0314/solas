import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeWatcher } from "@/components/preferences/theme-watcher";
import { preferencesScript } from "@/lib/preferences";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Solas",
    template: "%s · Solas",
  },
  description: "A private workspace for creating and working with AI agents.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The inline script sets data-theme / data-sidebar on <html> before React
    // hydrates, so React is told to accept those attribute differences.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: preferencesScript }} />
      </head>
      <body className="bg-background font-sans text-base text-foreground antialiased">
        <ThemeWatcher />
        {children}
      </body>
    </html>
  );
}
