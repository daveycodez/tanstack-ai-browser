import { promptApiAvailability } from "@tanstack-ai-browser/prompt-api"
import { useEffect, useState } from "react"

export function usePromptApiAvailable() {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let active = true
    const check = () => {
      void promptApiAvailability().then((availability) => {
        if (active) setAvailable(availability !== "unavailable")
      })
    }
    check()
    window.addEventListener("focus", check)
    return () => {
      active = false
      window.removeEventListener("focus", check)
    }
  }, [])
  return available
}
