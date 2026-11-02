import { Outlet } from "@tanstack/react-router"
import {
  HeadContent,
  Link,
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
      { title: "Checkers" },
      {
        name: "description",
        content:
          "Play checkers against an AI opponent that runs on your device."
      }
    ],
    links: [{ rel: "stylesheet", href: appCss }]
  }),
  shellComponent: RootDocument,
  component: () => (
    <GameStorageProvider>
      <Outlet />
    </GameStorageProvider>
  ),
  notFoundComponent: () => (
    <main>
      <h1>Page not found</h1>
      <Link to="/">Back to Checkers</Link>
    </main>
  )
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
