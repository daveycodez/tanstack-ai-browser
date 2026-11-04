import { useEffect, useId, useRef } from "react"
import type { ReactNode } from "react"
export function Dialog({
  title,
  children,
  onClose,
  wide = false
}: {
  title: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      className={wide ? "dialog dialog-wide" : "dialog"}
      ref={ref}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const r = event.currentTarget.getBoundingClientRect()
          if (
            event.clientX < r.left ||
            event.clientX > r.right ||
            event.clientY < r.top ||
            event.clientY > r.bottom
          )
            onClose()
        }
      }}
    >
      <div className="dialog-header">
        <h2 id={id}>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  )
}
export function Rules({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="A handful of simple rules." onClose={onClose}>
      <p className="dialog-intro">Kalah Mancala · 6 pits · 4 seeds each</p>
      <ol className="rules-list">
        <li>
          <strong>Pick a pit.</strong>
          <p>
            Choose any nonempty pit on your side.
            <span className="wide-copy"> Your pits are in the bottom row.</span>
            <span className="narrow-copy">
              {" "}
              On a phone, your pits are in the right column.
            </span>
          </p>
        </li>
        <li>
          <strong>Sow your seeds.</strong>
          <p>
            Move counterclockwise, dropping one seed in each pit. Include your
            store<span className="wide-copy"> on the right</span>
            <span className="narrow-copy"> at the top</span>; skip your
            opponent’s store.
          </p>
        </li>
        <li>
          <strong>Keep the rhythm.</strong>
          <p>Land your last seed in your store and you get another turn.</p>
        </li>
        <li>
          <strong>Make a capture.</strong>
          <p>
            Land your last seed in an empty pit on your side. If the opposite
            pit has seeds, collect those seeds and your last seed into your
            store.
          </p>
        </li>
        <li>
          <strong>Gather the rest.</strong>
          <p>
            When either row is empty, the other player collects all seeds left
            on their side. The most seeds in a store wins.
          </p>
        </li>
      </ol>
      <button className="button button-primary" onClick={onClose}>
        Let’s play
      </button>
    </Dialog>
  )
}
