import { useEffect, useRef } from "react"

export function ConfirmNewGame({
  onConfirm,
  onCancel
}: {
  onConfirm: () => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-labelledby="confirm-title"
      onCancel={onCancel}
    >
      <h2 id="confirm-title">Start a new game?</h2>
      <p>
        This will replace your current game. You can only keep one game at a
        time.
      </p>
      <div className="dialog-actions">
        <button
          className="button button-secondary"
          onClick={onCancel}
          autoFocus
        >
          Keep playing
        </button>
        <button className="button button-primary" onClick={onConfirm}>
          Start new game
        </button>
      </div>
    </dialog>
  )
}
