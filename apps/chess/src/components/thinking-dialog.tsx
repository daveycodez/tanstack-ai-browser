import { useEffect, useId, useRef } from "react"

type ThinkingDialogProps = {
  text: string
  onClose: () => void
}

export function ThinkingDialog({ text, onClose }: ThinkingDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const titleId = useId()

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (!element.open) element.showModal()
    return () => element.close()
  }, [])

  useEffect(() => {
    const element = content.current
    if (element && followLatest.current) {
      element.scrollTop = element.scrollHeight
    }
  }, [text])

  return (
    <dialog
      className="thinking-dialog"
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="thinking-dialog-header">
        <h2 id={titleId}>Model thinking</h2>
        <button
          type="button"
          className="thinking-dialog-close"
          aria-label="Close model thinking"
          onClick={onClose}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="m4 4 8 8m0-8-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <div
        className="thinking-dialog-content"
        ref={content}
        tabIndex={0}
        aria-label="Model thinking"
        onScroll={(event) => {
          const element = event.currentTarget
          followLatest.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 40
        }}
      >
        {text ? (
          <pre>{text}</pre>
        ) : (
          <p className="thinking-dialog-empty">
            Waiting for the model’s thinking…
          </p>
        )}
      </div>
    </dialog>
  )
}
