import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Extraction review",
  description: "Check every extracted value against the passage it came from.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="masthead">
          <Link href="/" className="wordmark">
            Extraction review
          </Link>
        </header>
        <Providers>
          <main className="page">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
