import { ThemeProvider } from "next-themes"
import { Outlet } from "@tanstack/react-router"
import {
  HeadContent,
  Link,
  Scripts,
  createRootRoute,
  useLocation
} from "@tanstack/react-router"
import type { ReactNode } from "react"
import { GameStorageProvider } from "../lib/db"
import appCss from "../styles.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Chess — a little room to think" },
      { name: "theme-color", content: "#182c4d" },
      {
        name: "description",
        content:
          "An unhurried game of chess against an AI that runs on your device. Play either side, choose your local opponent, and pick up where you left off."
      }
    ],
    links: [{ rel: "stylesheet", href: appCss }]
  }),
  shellComponent: RootDocument,
  component: RootContent,
  notFoundComponent: () => (
    <main>
      <h1>Page not found</h1>
      <Link to="/">Back to Chess</Link>
    </main>
  )
})

function RootContent() {
  const pathname = useLocation({ select: (location) => location.pathname })
  if (pathname === "/bench" || pathname === "/bench/" || pathname === "/bench-runtime" || pathname === "/bench-runtime/") return <Outlet />
  return (
    <GameStorageProvider>
      <Outlet />
    </GameStorageProvider>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider
          attribute="data-theme"
          storageKey="chess-theme"
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
