import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist, Instrument_Sans } from "next/font/google";
import { ConfigureAmplify } from "@/components/configure-amplify";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
// Solo para la palabra "clipflow" del logo.
const instrumentSans = Instrument_Sans({ variable: "--font-instrument-sans", subsets: ["latin"], weight: "600" });

export const metadata: Metadata = {
  metadataBase: new URL("https://clipflowia.com"),
  title: "ClipFlow",
  description: "Convierte videos largos en clips cortos para redes sociales.",
};

export const viewport: Viewport = {
  themeColor: "#0a0c10",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" className={`${geistSans.variable} ${instrumentSans.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <ConfigureAmplify />
        {children}
      </body>
    </html>
  );
}
