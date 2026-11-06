import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RTM Intelligence",
  description: "AI-powered Excel reporting workspace"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
