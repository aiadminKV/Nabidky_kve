import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin", "latin-ext"],
  variable: "--font-inter",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin", "latin-ext"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "K&V ELEKTRO – Data Bridge PRO",
  description: "AI-řízené zpracování B2B poptávek pro K&V ELEKTRO a.s.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="cs" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="bg-kv-gray-50 text-kv-gray-800 antialiased">{children}</body>
    </html>
  );
}
