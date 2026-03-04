import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin", "latin-ext"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "K&V ELEKTRO – Správce nabídek",
  description: "AI-řízené zpracování B2B poptávek pro K&V ELEKTRO a.s.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="cs" className={inter.variable}>
      <body className="bg-white text-kv-gray-800 antialiased">{children}</body>
    </html>
  );
}
