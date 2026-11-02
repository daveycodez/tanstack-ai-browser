import { useEffect, useId, useRef, useState } from "react"
import {
  opponentOption,
  resolveOpponent,
  WEBGL_OPPONENTS
} from "../lib/opponents"
import type { OpponentSettings } from "../lib/opponents"

type OpponentPickerProps = {
  value: OpponentSettings
  promptApiAvailable: boolean
  disabled?: boolean
  onChange: (next: OpponentSettings) => void
}

export function OpponentPicker({
  value,
  promptApiAvailable,
  disabled = false,
  onChange
}: OpponentPickerProps) {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDetailsElement>(null)
  const trigger = useRef<HTMLElement>(null)
  const id = useId()
  const selected = opponentOption(value.model)
  const options =
    promptApiAvailable || value.model === "prompt-api"
      ? [opponentOption("prompt-api"), ...WEBGL_OPPONENTS]
      : WEBGL_OPPONENTS

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !container.current?.contains(event.target)
      ) {
        setOpen(false)
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  return (
    <details className="opponent-picker" ref={container} open={open}>
      <summary
        className="opponent-picker-trigger"
        ref={trigger}
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        aria-disabled={disabled}
        title={`Change opponent: ${selected.label}`}
        onClick={(event) => {
          event.preventDefault()
          if (!disabled) setOpen((previous) => !previous)
        }}
      >
        <span>{selected.label}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m2 3.5 3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div className="opponent-menu" id={`${id}-menu`}>
        <div className="opponent-menu-heading">Choose your opponent</div>
        <fieldset className="opponent-options" disabled={disabled}>
          <legend className="opponent-sr-only">Opponent model</legend>
          {options.map((option) => {
            const unavailable =
              option.id === "prompt-api" && !promptApiAvailable
            return (
              <label
                className={`opponent-option${value.model === option.id ? " opponent-option-selected" : ""}${unavailable ? " opponent-option-unavailable" : ""}`}
                key={option.id}
              >
                <input
                  type="radio"
                  name={`${id}-model`}
                  value={option.id}
                  checked={value.model === option.id}
                  disabled={unavailable}
                  onClick={() => {
                    if (value.model === option.id) {
                      setOpen(false)
                      trigger.current?.focus()
                    }
                  }}
                  onChange={() => {
                    setOpen(false)
                    trigger.current?.focus()
                    onChange(
                      resolveOpponent({
                        model: option.id,
                        thinking: value.thinking
                      })
                    )
                  }}
                />
                <span className="opponent-option-copy">
                  <span>{option.label}</span>
                </span>
              </label>
            )
          })}
        </fieldset>
        {selected.thinking !== "none" && (
          <div className="opponent-thinking">
            <label>
              <input
                type="checkbox"
                checked={selected.thinking === "required" || value.thinking}
                disabled={disabled || selected.thinking === "required"}
                onChange={(event) =>
                  onChange(
                    resolveOpponent({
                      model: value.model,
                      thinking: event.target.checked
                    })
                  )
                }
              />
              <span>
                {selected.thinking === "required"
                  ? "Thinking (always on)"
                  : "Thinking"}
              </span>
            </label>
          </div>
        )}
      </div>
    </details>
  )
}
