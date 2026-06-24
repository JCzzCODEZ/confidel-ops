import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Confidel Operations",
  description: "Confidel operations dashboard",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
