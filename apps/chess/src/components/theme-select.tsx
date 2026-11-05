import { useTheme } from "next-themes"
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react"

const subscribe = () => () => undefined
const choices = ["system", "light", "dark"] as const

function ThemeIcon({
  theme,
  className,
  size = 18
}: {
  theme: "light" | "dark" | "system"
  className?: string
  size?: number
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {theme === "light" ? (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4" />
        </>
      ) : theme === "dark" ? (
        <path d="M20.4 14.2A8.6 8.6 0 0 1 9.8 3.6a8.6 8.6 0 1 0 10.6 10.6Z" />
      ) : (
        <>
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M12 17v4m-4 0h8" />
        </>
      )}
    </svg>
  )
}

export function ThemeSelect() {
  const { theme, setTheme } = useTheme()
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  )
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const keyboardOpen = useRef(false)
  const id = useId()

  useEffect(() => {
    if (!open) return
    if (keyboardOpen.current) {
      container.current
        ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
        ?.focus()
      keyboardOpen.current = false
    }
    const closeOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !container.current?.contains(event.target)
      )
        setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener("pointerdown", closeOutside)
    document.addEventListener("keydown", escape)
    return () => {
      document.removeEventListener("pointerdown", closeOutside)
      document.removeEventListener("keydown", escape)
    }
  }, [open])

  return (
    <div
      className="theme-select"
      ref={container}
      data-open={open}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <button
        type="button"
        className="theme-trigger"
        ref={trigger}
        aria-label="Choose theme"
        title="Choose theme"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={(event) => {
          event.preventDefault()
          keyboardOpen.current = event.detail === 0
          setOpen((previous) => !previous)
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault()
            if (open)
              container.current
                ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
                ?.focus()
            else {
              keyboardOpen.current = true
              setOpen(true)
            }
          }
        }}
      >
        {/* Both icons are prerendered; CSS alone chooses the resolved theme. */}
        <ThemeIcon theme="light" className="theme-sun" size={20} />
        <ThemeIcon theme="dark" className="theme-moon" size={20} />
      </button>
      <div
        className="theme-menu"
        id={id}
        hidden={!open}
        role="menu"
        aria-label="Theme"
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
            return
          event.preventDefault()
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>("button")
          )
          const current = items.indexOf(
            document.activeElement as HTMLButtonElement
          )
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    items.length) %
                  items.length
          items[next]?.focus()
        }}
      >
        {choices.map((choice) => {
          const selected = (mounted ? (theme ?? "system") : "system") === choice
          return (
            <button
              key={choice}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                setTheme(choice)
                setOpen(false)
                trigger.current?.focus()
              }}
            >
              <span className="theme-option-label">
                <ThemeIcon theme={choice} />
                <span>{choice[0].toUpperCase() + choice.slice(1)}</span>
              </span>
              <span className="theme-check" aria-hidden="true">
                ✓
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
