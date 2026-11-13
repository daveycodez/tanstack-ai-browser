import { Capacitor } from "@capacitor/core"
import { StatusBar, Style } from "@capacitor/status-bar"
import { useTheme } from "next-themes"
import { useEffect } from "react"

/**
 * In the iOS app (Capacitor), the status bar's text follows the app's theme:
 * dark text on the light theme, light text on the dark one. iOS would
 * otherwise follow the system's appearance, so the light theme on a phone in
 * dark mode gets white text, which iOS darkens the page behind to keep
 * readable. Renders nothing, and does nothing on the web or in Electron.
 */
export function NativeStatusBar() {
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !resolvedTheme) return
    // Style.Light is dark text for light backgrounds; Style.Dark the reverse.
    StatusBar.setStyle({
      style: resolvedTheme === "dark" ? Style.Dark : Style.Light
    }).catch((error: unknown) => {
      console.error("Couldn't set the status bar style", error)
    })
  }, [resolvedTheme])

  return null
}
