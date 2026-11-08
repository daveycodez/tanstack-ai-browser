import { isSupported } from "@tanstack-ai-browser/prompt-api"
import { useEffect, useState } from "react"

export function usePromptApiAvailable() {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let active = true
    const check = () => {
      void isSupported().then((supported) => {
        if (active) setAvailable(supported)
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
