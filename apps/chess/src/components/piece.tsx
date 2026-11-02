import type { PieceType, Side } from "../lib/chess"

export const pieceNames: Record<PieceType, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king"
}

export function PieceArt({
  side,
  type = "k"
}: {
  side: Side
  type?: PieceType
}) {
  return (
    <svg
      className={`chess-piece piece-${side}`}
      viewBox="0 0 64 64"
      aria-hidden="true"
      fill="currentColor"
      stroke="var(--piece-outline)"
      strokeWidth="1.65"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      {type === "p" && (
        <>
          <circle cx="32" cy="18" r="8" />
          <path d="M26 27h12l-2 12 7 10H21l7-10z" />
          <path d="M20 49h24l3 7H17z" />
        </>
      )}
      {type === "r" && (
        <>
          <path d="M18 10h7v7h5v-7h5v7h5v-7h7v14l-6 5 2 20H21l2-20-5-5z" />
          <path d="M19 49h26l3 7H16z" />
          <path d="M23 26h18M23 44h18" fill="none" />
        </>
      )}
      {type === "b" && (
        <>
          <path d="M32 7c-5 6-13 10-13 18 0 7 6 11 13 11s13-4 13-11C45 17 37 13 32 7z" />
          <path d="m35 15-7 12" fill="none" />
          <path d="M27 35h10l-1 6 7 8H21l7-8z" />
          <path d="M20 49h24l3 7H17z" />
        </>
      )}
      {type === "n" && (
        <>
          <path d="m22 13 4-7 8 6c13 2 16 13 14 24l-2 13H20c0-11 10-15 12-24l-9 8-9-5 4-10z" />
          <path d="m31 12 3 8-6 8M21 23h3" fill="none" />
          <path d="M18 49h29l2 7H15z" />
        </>
      )}
      {type === "q" && (
        <>
          <path d="m16 21 10 8 6-15 6 15 10-8-6 21H22z" />
          <circle cx="14" cy="17" r="3.5" />
          <circle cx="32" cy="10" r="3.5" />
          <circle cx="50" cy="17" r="3.5" />
          <path d="M23 42h18l2 7H21zM20 49h24l3 7H17z" />
          <path d="M23 37h18" fill="none" />
        </>
      )}
      {type === "k" && (
        <>
          <path d="M32 5v13m-5-8h10" fill="none" strokeWidth="3.5" />
          <path d="M32 21c-9-9-20-1-15 9l8 12h14l8-12c5-10-6-18-15-9z" />
          <path d="M24 42h16l3 7H21zM20 49h24l3 7H17z" />
          <path d="M26 36h12" fill="none" />
        </>
      )}
      <path d="M22 53h20" fill="none" opacity=".45" />
    </svg>
  )
}

export function BrandMark() {
  return (
    <span className="brand-mark">
      <PieceArt side="ai" type="n" />
    </span>
  )
}
