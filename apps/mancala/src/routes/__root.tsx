import { ThemeProvider } from "next-themes"
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute
} from "@tanstack/react-router"
import type { ReactNode } from "react"
import { GameStorageProvider } from "../lib/db"
import appCss from "../styles.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Mancala · A handful of possibilities" },
      {
        name: "description",
        content:
          "Slow down with a game of Mancala. Sow, capture, and play against a local AI opponent on your device."
      },
      { name: "theme-color", content: "#edf3ed" }
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/icon.svg" }
    ]
  }),
  shellComponent: RootDocument,
  component: () => (
    <GameStorageProvider>
      <Outlet />
    </GameStorageProvider>
  ),
  notFoundComponent: () => (
    <main className="storage-screen">
      <h1>A little off the board.</h1>
      <Link to="/">Back to Mancala</Link>
    </main>
  )
})
function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider
          attribute="data-theme"
          storageKey="mancala-theme"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  )
}
