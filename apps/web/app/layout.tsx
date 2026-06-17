import type { Metadata } from "next";
import "./globals.css";
import { Shell } from "./components/Shell";
import { ToastProvider } from "./components/Toast";

export const metadata: Metadata = {
  title: "Agent Engine · Control Room",
  description: "Watch and steer the Arzonic multi-agent debate engine.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="h-screen overflow-hidden">
        <ToastProvider>
          <Shell>{children}</Shell>
        </ToastProvider>
      </body>
    </html>
  );
}
