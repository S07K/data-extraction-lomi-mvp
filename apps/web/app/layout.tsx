import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/Sidebar";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Review desk",
  description: "Check every extracted value against the passage it came from.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="shell">
            <Sidebar />
            <main className="main">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
