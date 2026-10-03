import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist, Instrument_Sans } from "next/font/google";
import { ConfigureAmplify } from "@/components/configure-amplify";
import { LocaleProvider } from "@/i18n/provider";
import { getLocale, getT } from "@/i18n/server";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
// Solo para la palabra "clipflow" del logo.
const instrumentSans = Instrument_Sans({ variable: "--font-instrument-sans", subsets: ["latin"], weight: "600" });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    metadataBase: new URL("https://clipflowia.com"),
    title: "ClipFlow",
    description: t.meta.description,
  };
}

export const viewport: Viewport = {
  themeColor: "#0a0c10",
  colorScheme: "dark",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${geistSans.variable} ${instrumentSans.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <ConfigureAmplify />
        <LocaleProvider initial={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
