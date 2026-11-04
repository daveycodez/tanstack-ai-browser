import { colorName, squareName } from "./chess.ts"
import type {
  AnnotatedMove,
  Game,
  PieceRef,
  PieceType,
  Side,
  PromotionReply
} from "./chess.ts"
import { describePosition } from "./ai-position.ts"
import { buildCompactChoices } from "./prompt-options.ts"
import { moveChoiceLabel } from "./move-choice.ts"

export const SHARED_PROMPT_VERSION = "shared-v60"

// Construction vocabulary only; requests use the player-relative systemPromptFor().
export const SHARED_SYSTEM_PROMPT = [
  "Play chess as Black. Trust the supplied outcomes to choose one legal move; card order is not a ranking.",
  "Take a listed CHECKMATE now. Otherwise stop White's mate or answer check, save or win a queen, then prefer safe material over castling/development.",
  "BOARD NOW is current. AFTER describes only that Black move; never combine cards. CHECK checks White; Black-in-check describes now.",
  "Negative net means Black loses material. Weigh recaptures and forcing follow-ups. Forcing gains can outweigh immediate captures; check alone cannot justify material loss. Protection is not immunity. Values: pawn 1, knight/bishop 3, rook 5, queen 9."
].join("\n\n")

/** Color roles vary by game; the policy and model-independent instructions stay fixed. */
function roleText(text: string, game: Pick<Game, "humanColor">): string {
  if (game.humanColor !== "black") return text
  const colors: Record<string, string> = { Black: "White", White: "Black", BLACK: "WHITE", WHITE: "BLACK" }
  return text.replace(/\b(?:Black|White|BLACK|WHITE)\b/g, word => colors[word])
}
/** Name ownership from the model's perspective without changing board coordinates. */
function playerNames(text: string, game: Pick<Game, "humanColor">): string {
  const own = game.humanColor === "black" ? "White" : "Black"
  const enemy = own === "Black" ? "White" : "Black"
  const tone = own === "Black" ? "dark" : "light"
  const otherTone = enemy === "Black" ? "dark" : "light"
  let result = text
    .replace(`Play chess as ${own}.`, `You control the ${tone} chess pieces.`)
    .replace(`${own} pieces:`, `Your pieces (${tone}):`)
    .replace(`${enemy} pieces:`, `Opponent's pieces (${otherTone}):`)
    .replaceAll(`${own} in check:`, "Your king in check:")
    .replaceAll(`${own}-in-check`, "Your king-in-check")
    .replaceAll(`No threatened ${own} non-king pieces.`, "None of your non-king pieces are threatened.")
    .replaceAll(`${own} can `, "You can ")
    .replaceAll(`${own} also threatens `, "You also threaten ")
    .replaceAll(`${own} loses `, "you lose ")
    .replaceAll(`${own} is `, "you are ")
    .replaceAll(`${enemy}'s`, "your opponent's")
  for (const noun of ["king", "queen", "rook", "bishop", "knight", "pawn", "piece", "move", "capture", "non-king"])
    result = result.replaceAll(`${own} ${noun}`, `your ${noun}`).replaceAll(`${enemy} ${noun}`, `opponent's ${noun}`)
  return result.replaceAll("that your move", "your move")
    .replaceAll("opponent's moves next", "opponent moves next")
    .replaceAll("no your capture", "no capture for you")
    .replaceAll("enemy king", "opponent's king").replaceAll(own, "you").replaceAll(enemy, "opponent")
    .replaceAll(own.toUpperCase(), "YOU").replaceAll(enemy.toUpperCase(), "OPPONENT")
    .replace(/^you:/gm, "You:").replace(/^opponent:/gm, "Opponent:")
}

export const systemPromptFor = (game: Pick<Game, "humanColor">): string =>
  playerNames(roleText(SHARED_SYSTEM_PROMPT, game), game)

export type SharedPromptInput = {
  game: Game
  moves: readonly AnnotatedMove[]
  currentThreats: readonly { target: PieceRef; attackers: PieceRef[] }[]
}

const pieceNames: Record<PieceType, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king"
}
const numericValues: Record<PieceType, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0
}
const pieceLabel = (piece: PieceRef) =>
  `${pieceNames[piece.piece]} (${piece.piece === "k" ? "royal" : numericValues[piece.piece]}) on ${squareName(piece.square)}`

const signedMaterial = (value: number) => `${value > 0 ? "+" : ""}${value}`
const promotionNet = (reply: PromotionReply) =>
  Math.max(reply.netAfterPromotion, reply.netAfterImmediateCapture ?? -Infinity)

/** Actual promotion-reply facts, without treating every promotion as a loss. */
function hasUnansweredPromotionLoss(move: AnnotatedMove): boolean {
  return (
    move.outcome.promotionReplies?.some(
      (reply) => reply.checkmate || promotionNet(reply) < 0
    ) ?? false
  )
}

function promotionContext(move: AnnotatedMove, side: Side, game: Game): string[] {
  const replies = move.outcome.promotionReplies
  if (!replies?.length) return []
  const groups = new Map<string, PromotionReply[]>()
  for (const reply of replies) {
    const key = `${reply.from}:${reply.to}`
    const group = groups.get(key) ?? []
    group.push(reply)
    groups.set(key, group)
  }
  const own = colorName(game, side)
  const enemy = colorName(game, side === "ai" ? "human" : "ai")
  const facts = [...groups.values()].map((group) => {
    const roles = (["q", "r", "b", "n"] as const).flatMap((role) =>
      group.filter((reply) => reply.promotion === role)
    )
    const allCapturable = roles.every(
      (reply) =>
        reply.netAfterImmediateCapture !== undefined &&
        reply.capturableBy.length > 0
    )
    const noneCapturable = roles.every(
      (reply) => reply.netAfterImmediateCapture === undefined
    )
    const outcomes = roles
      .map(
        (reply) =>
          `${reply.promotion.toUpperCase()}${reply.checkmate ? "(mate)" : reply.check ? "(check)" : ""}${signedMaterial(promotionNet(reply))}${!allCapturable && !noneCapturable ? (reply.netAfterImmediateCapture === undefined ? " no capture" : " after capture") : ""}`
      )
      .join("/")
    const common = roles[0].capturableBy.filter((piece) =>
      roles.every((reply) =>
        reply.capturableBy.some(
          (entry) =>
            entry.piece === piece.piece && entry.square === piece.square
        )
      )
    )
    const capture = allCapturable
      ? `${own} capture available${common.length ? ` (${pieceNames[common[0].piece]} ${squareName(common[0].square)})` : ""}, best net`
      : noneCapturable
        ? `no ${own} capture, net`
        : "net per reply"
    const loss = roles.some(
      (reply) => reply.checkmate || promotionNet(reply) < 0
    )
    return {
      loss,
      text: `${loss ? "promotion risk" : "promotion"}: ${enemy} ${squareName(group[0].from)}${group[0].captured ? "x" : "-"}${squareName(group[0].to)}, ${capture} ${outcomes}`
    }
  })
  // Urgent factual branches precede neutral, compensated promotion replies.
  return facts
    .filter((fact) => fact.loss)
    .concat(facts.filter((fact) => !fact.loss))
    .map((fact) => fact.text)
}

function kingMobilityContext(move: AnnotatedMove, side: Side, game: Game): string[] {
  const mobility = move.outcome.kingMobility
  if (
    !mobility ||
    mobility.opponentNonPawnNonKingCount > 3 ||
    move.outcome.allowsMateInOne ||
    hasUnansweredPromotionLoss(move) ||
    move.outcome.replyMaterialLosses?.some((loss) => loss.netMaterial < 0)
  )
    return []
  const restricts =
    mobility.before.length > mobility.after.length &&
    mobility.deniedSquares.length > 0
  const approaches =
    mobility.opponentBareKing &&
    mobility.ownKingDistance &&
    mobility.ownKingDistance.after < mobility.ownKingDistance.before
  if (!restricts && !approaches) return []
  const own = colorName(game, side)
  const enemy = colorName(game, side === "ai" ? "human" : "ai")
  const destinations = mobility.after.map(squareName).join(",") || "none"
  const denied = mobility.deniedSquares.map(squareName).join(",") || "none"
  const facts = [
    `${enemy} king legal destinations ${mobility.before.length}->${mobility.after.length} [${destinations}], denied [${denied}], other legal replies ${mobility.otherLegalReplyCount}`
  ]
  if (approaches && mobility.ownKingDistance)
    facts.push(
      `${own} king square distance to bare ${enemy} king ${mobility.ownKingDistance.before}->${mobility.ownKingDistance.after}`
    )
  return facts
}

/** Frame-level relevance; this changes information emphasis, never legal choices. */
function hasTacticalFocus({
  game,
  moves,
  currentThreats
}: SharedPromptInput): boolean {
  return (
    game.inCheck ||
    currentThreats.some((threat) => threat.target.piece === "q") ||
    moves.some(
      (move) =>
        move.outcome.checkmate ||
        move.outcome.allowsMateInOne ||
        hasUnansweredPromotionLoss(move) ||
        (move.captured &&
          numericValues[move.captured] >= 3 &&
          move.outcome.recapture.count === 0 &&
          move.outcome.replyMaterialLosses?.length === 0 &&
          !move.outcome.allowsMateInOne &&
          !move.outcome.stalemate &&
          !move.outcome.drawReason &&
          !hasUnansweredPromotionLoss(move))
    )
  )
}

/** Positive factual summaries; the complete legal-choice list remains below. */
export function positiveSafetySummaries({
  game,
  moves,
  currentThreats
}: SharedPromptInput): string[] {
  const own = colorName(game, "ai"), enemy = colorName(game, "human")
  const tacticalFocus = hasTacticalFocus({ game, moves, currentThreats })
  const hasPromotionReplies = moves.some(
    (move) => (move.outcome.promotionReplies?.length ?? 0) > 0
  )
  const facts: string[] = []
  let hasKingSafeChoices = false
  let hasQueenRescueChoices = false
  let hasMaterialSafeChoices = false
  if (moves.some((move) => move.outcome.allowsMateInOne)) {
    const safe = moves.filter(
      (move) =>
        !move.outcome.allowsMateInOne &&
        move.outcome.replyMajorLosses !== undefined &&
        move.outcome.replyMajorLosses.length === 0 &&
        !hasUnansweredPromotionLoss(move)
    )
    if (safe.length) {
      hasKingSafeChoices = true
      facts.push(
        `KING-SAFE CHOICES FOR THE NEXT TURN: ${safe.map(moveChoiceLabel).join(", ")}. Each prevents an immediate ${enemy} checkmate without an uncompensated queen or rook loss.`
      )
    }
  }
  if (currentThreats.some((threat) => threat.target.piece === "q")) {
    const rescues = moves.filter(
      (move) =>
        !move.outcome.allowsMateInOne &&
        !hasUnansweredPromotionLoss(move) &&
        move.outcome.relationships?.resolvedThreats.some(
          (piece) => piece.piece === "q"
        )
    )
    if (rescues.length) {
      hasQueenRescueChoices = true
      facts.push(
        `${own} can RESCUE AN ATTACKED QUEEN from immediate legal capture with: ${rescues.map(moveChoiceLabel).join(", ")}.`
      )
    }
  }
  const hasImmediateWin = moves.some((move) => move.outcome.checkmate)
  if (
    !hasImmediateWin &&
    moves.some((move) =>
      move.outcome.replyMaterialLosses?.some((loss) => loss.netMaterial < 0)
    )
  ) {
    const safe = moves.filter(
      (move) =>
        !move.outcome.allowsMateInOne &&
        move.outcome.replyMaterialLosses?.length === 0 &&
        !hasUnansweredPromotionLoss(move)
    )
    if (safe.length) {
      hasMaterialSafeChoices = true
      facts.push(
        `MATERIAL-SAFE CHOICES FOR THE NEXT TURN: ${safe.map(moveChoiceLabel).join(", ")}. ${hasPromotionReplies ? `No checked immediate capture or promotion reply leaves ${own} with uncompensated material loss; ${enemy} has no mate in one.` : `No checked immediate capture exchange loses ${own} material; ${enemy} has no mate in one.`}`
      )
    }
  }
  if (
    !hasImmediateWin &&
    (hasKingSafeChoices || hasQueenRescueChoices || hasMaterialSafeChoices)
  ) {
    facts.push("URGENT RESPONSE PRIORITY:")
    if (hasKingSafeChoices)
      facts.push(
        `Choose one of the listed KING-SAFE moves: stop ${enemy}'s mate without sacrificing a queen or rook, ahead of checks, captures or development.`
      )
    if (hasQueenRescueChoices)
      facts.push(
        `Address the attacked queen with one of the queen-rescue choices above that prevents an immediate ${enemy} win, before ordinary development or castling.`
      )
    if (hasMaterialSafeChoices)
      facts.push(
        tacticalFocus
          ? "After king/queen safety, choose among MATERIAL-SAFE moves. Prefer captures or forcing gains over quiet moves or non-winning checks; avoid negative exchange nets."
          : "After king/queen safety, choose a listed MATERIAL-SAFE move. Keep threatened pieces defended before castling or development."
      )
  }
  return facts.length ? ["URGENT POSITION FACTS:", ...facts] : []
}

/** Compact positional facts; never a score, a rescue claim, or a move filter. */
function positionalContext(
  move: AnnotatedMove,
  side: Side,
  tacticalFocus: boolean,
  game: Game
): string | undefined {
  if (
    move.outcome.checkmate ||
    move.outcome.stalemate ||
    move.outcome.drawReason
  )
    return undefined
  const facts = promotionContext(move, side, game)
  if (!tacticalFocus) facts.push(...kingMobilityContext(move, side, game))
  const mobility = move.outcome.mobility
  if (!tacticalFocus && move.piece === "p" && mobility) {
    const opened = mobility.changedOtherPieces.filter(
      (piece) => piece.after > piece.before && piece.newSquares.length > 0
    )
    const minor =
      opened.find((piece) => piece.piece === "b") ??
      opened.find((piece) => piece.piece === "n")
    const piece = minor ?? opened.find((entry) => entry.piece === "q")
    const opening: string[] = []
    if (
      mobility.pawnAdvance?.squares === 2 &&
      "de".includes(squareName(move.path[1])[0])
    )
      opening.push("central pawn advances 2 squares")
    if (piece)
      opening.push(
        piece.piece === "b"
          ? `${piece.before === 0 ? "frees blocked bishop" : "opens diagonal for bishop"} ${squareName(piece.square)}`
          : piece.piece === "n"
            ? `opens route for knight ${squareName(piece.square)}`
            : `queen ${squareName(piece.square)} line opens`
      )
    if (opening.length) facts.push(opening.join(", "))
  }
  const castle = move.outcome.castling
  const lost = castle?.lostRights.filter((right) => right.side === side) ?? []
  if (lost.length && !castle?.performed)
    facts.push(
      `${lost.map((right) => right.wing).join(" and ")} castling rights: held->gone`
    )
  const cover = move.outcome.kingCover
  if (!tacticalFocus && cover && (move.piece === "p" || castle?.performed)) {
    for (const profile of cover.after) {
      if (profile.side !== side || !cover.relevantWings.includes(profile.wing))
        continue
      const before = cover.before.find(
        (entry) => entry.kind === profile.kind && entry.wing === profile.wing
      )
      if (
        profile.kind === "future" &&
        (!before ||
          (castle &&
            !castle.paths.some(
              (path) =>
                path.side === side &&
                path.wing === profile.wing &&
                path.rightBefore &&
                path.rightAfter
            )))
      )
        continue
      const count = `${before ? `${before.nearFiles.length}->` : ""}${profile.nearFiles.length}`
      const pawns =
        profile.pawnSquares.map(squareName).sort().join(",") || "none"
      facts.push(
        `${profile.kind === "current" ? `current king ${squareName(profile.kingSquare)}` : "future castle"} ${profile.wing} near-files ${count} [${pawns}]`
      )
    }
  }
  const path = castle?.paths.find(
    (entry) =>
      entry.side === side &&
      entry.rightBefore &&
      entry.rightAfter &&
      entry.clearedSquares.length > 0
  )
  if (!tacticalFocus && path && !castle?.performed)
    facts.push(
      `${path.wing} ${
        path.pathClear
          ? `path clear, castling ${path.legalNow ? "legal on unchanged board" : "temporarily prevented"}`
          : `clears ${path.clearedSquares.map(squareName).join(",")}, still blocked ${path.blockersAfter.map(squareName).join(",")}`
      }`
    )
  const support = move.outcome.support?.addedFriendlySupport.filter(
    (entry) =>
      (entry.target.piece === "q" || entry.target.piece === "r") &&
      (entry.wasThreatened || entry.beforeCount === 0) &&
      entry.afterCount > entry.beforeCount
  )
  const protectedPiece =
    support?.find((entry) => entry.target.piece === "q") ?? support?.[0]
  if (protectedPiece && (!tacticalFocus || protectedPiece.wasThreatened))
    facts.push(
      `adds protection to ${protectedPiece.wasThreatened ? "attacked " : ""}${pieceNames[protectedPiece.target.piece]} ${squareName(protectedPiece.target.square)} (${protectedPiece.beforeCount}->${protectedPiece.afterCount})`
    )
  const concise: string[] = []
  let length = 0
  for (const fact of facts) {
    if (concise.length === 3 || length + fact.length + 2 > 180) continue
    concise.push(fact)
    length += fact.length + 2
  }
  return concise.length ? concise.join("; ") : undefined
}

/** One fixed chess prompt for every adapter; preserve the caller's legal order. */
export function buildSharedPrompt({
  game,
  moves,
  currentThreats
}: SharedPromptInput): {
  prompt: string
  systemPrompt: string
  choices: { id: string; notation: string; label: string; outcome: string }[]
} {
  const own = colorName(game, "ai"), enemy = colorName(game, "human")
  const tacticalFocus = hasTacticalFocus({ game, moves, currentThreats })
  const movesById = new Map(moves.map((move) => [move.id, move]))
  const choices = buildCompactChoices({
    moves,
    currentThreatData: currentThreats,
    choices: moves.map((move) => ({ id: move.id, outcome: "" })),
    queenValue: 9
  }).map((choice) => {
    let outcome = roleText(choice.outcome.replace(
      "WHITE CAN CHECKMATE NEXT TURN",
      "LOSS NEXT TURN: White mates Black"
    ), game)
    const move = movesById.get(choice.id)
    if (!move) throw new Error("A legal card has no matching move.")
    if (
      move &&
      !move.outcome.checkmate &&
      !move.outcome.stalemate &&
      !move.outcome.drawReason
    ) {
      const fullExchangeFacts = move.outcome.replyMaterialLosses
      if (fullExchangeFacts !== undefined) {
        outcome = outcome
          .replace(/IF RECAPTURED NEXT TURN: [^;]+(?:; )?/, "")
          .replace(/; $/, "")
        if (fullExchangeFacts.length === 0 && outcome.endsWith(" | "))
          outcome += "COMPENSATING RECAPTURE AVAILABLE"
      }
      const losses =
        fullExchangeFacts ??
        move.outcome.replyMajorLosses?.filter(
          (loss) => loss.square !== move.path[1]
        )
      const exposed = losses
        ?.filter((loss) => loss.netMaterial < 0)
        .sort((left, right) => left.netMaterial - right.netMaterial)[0]
      if (exposed) {
        outcome += `${outcome.endsWith(" | ") ? "" : "; "}DANGER TO ${own.toUpperCase()}: after this move ${enemy} ${pieceLabel(exposed.capturedBy)} can take ${own} ${pieceLabel({ piece: exposed.piece, square: exposed.square })}; possible immediate exchange net ${exposed.netMaterial}`
        const newThreat = move.outcome.relationships?.newThreats[0]
        if (newThreat)
          outcome += `; ${own} also threatens ${enemy} ${pieceLabel(newThreat.target)} on the unchanged board; ${enemy} moves next`
      }
    }
    const context = positionalContext(move, game.turn, tacticalFocus, game)
    if (context) outcome += `; CONTEXT: ${context}`
    return {
      id: choice.id,
      notation: move.notation,
      label: moveChoiceLabel(move),
      outcome: `${moveChoiceLabel(move)} | AFTER: ${outcome.slice(outcome.indexOf(" | ", choice.id.length + 3) + 3)}`
    }
  })
  const board = describePosition(game)
    .split("\n")
    .filter((line) =>
      /^(Black pieces|White pieces|King:|Queens:|Rooks:|Bishops:|Knights:|Pawns:)/.test(
        line
      )
    )
    .map((line) => line.replace(" (you)", "").replace(" (opponent)", ""))
  const currentPieceLabel = (piece: PieceRef) => `${pieceNames[piece.piece]} ${squareName(piece.square)}`
  const threats = currentThreats.map(
    (threat) =>
      `${own} ${currentPieceLabel(threat.target)} can be captured by ${enemy} ${threat.attackers.map(currentPieceLabel).join(", ")}.`
  )
  const castles = moves.flatMap((move) =>
    move.notation.startsWith("O-O")
      ? [
          {
            id: move.id,
            notation: move.notation,
            label: moveChoiceLabel(move),
            landing: move.outcome.kingCover?.landing,
            promotionLoss: hasUnansweredPromotionLoss(move),
            wing: move.notation.startsWith("O-O-O") ? "queenside" : "kingside"
          }
        ]
      : []
  )
  const castleIds = castles.map((move) => move.label).join(", ") || "none"
  const preferredCastles = castles.filter(
    (move) =>
      (move.landing === undefined || move.landing.nearFiles.length === 3) &&
      !move.promotionLoss
  )
  const focusCastling =
    !tacticalFocus &&
    preferredCastles.length > 0 &&
    !game.inCheck &&
    !currentThreats.some((threat) => threat.target.piece === "q") &&
    !moves.some(
      (move) =>
        move.outcome.checkmate ||
        move.outcome.allowsMateInOne ||
        (move.captured &&
          numericValues[move.captured] >= 3 &&
          move.outcome.recapture.count === 0)
    )
  const wins = moves
    .filter((move) => move.outcome.checkmate)
    .map(moveChoiceLabel)
  const safeCaptures = moves.flatMap((move) => {
    if (
      !move.captured ||
      move.captured === "k" ||
      move.outcome.recapture.count !== 0 ||
      move.outcome.replyMaterialLosses?.length !== 0 ||
      move.outcome.allowsMateInOne ||
      move.outcome.checkmate ||
      move.outcome.stalemate ||
      move.outcome.drawReason ||
      hasUnansweredPromotionLoss(move)
    )
      return []
    return [
      {
        id: move.id,
        notation: move.notation,
        label: moveChoiceLabel(move),
        piece: move.captured,
        value: numericValues[move.captured]
      }
    ]
  })
  const recent = game.history
    .slice(-8)
    .map(
      (move) =>
        `${colorName(game, move.side)}: ${move.notation} (${move.id})`
    )
  const fullMove = Number(game.fen.split(" ")[5])
  const showOpening = !tacticalFocus && fullMove <= 10
  const showCover =
    !tacticalFocus &&
    choices.some((choice) => /; CONTEXT: [^\n]*near-files/.test(choice.outcome))
  const showCoordination =
    !tacticalFocus &&
    moves.some((move) => {
      const phase = move.outcome.kingMobility
      return (
        phase &&
        (phase.opponentNonPawnNonKingCount <= 3 || phase.opponentBareKing)
      )
    })
  const showPromotion =
    !wins.length &&
    moves.some((move) => (move.outcome.promotionReplies?.length ?? 0) > 0)
  const prompt = [
    "BOARD NOW:",
    ...(showOpening
      ? [
          "Central pawn pushes gain space and can free bishops or knights."
        ]
      : []),
    ...(showCover
      ? [
          "Near-files counts pawn files on the two pawn ranks nearest home. Balance cover with space, piece activity and castling; no material score or pawn-move ban."
        ]
      : []),
    ...(showPromotion
      ? [
          "Answer promotion threats unless legal recaptures or material gains compensate."
        ]
      : []),
    ...(showCoordination
      ? [
          "Coordinate king and major pieces to restrict the enemy king; keep material, avoid stalemate. Destination counts alone do not prove mate."
        ]
      : []),
    ...board,
    `Position FEN: ${game.fen}`,
    `${own} in check: ${game.inCheck ? "yes" : "no"}.`,
    `${enemy} capture possibilities on the unchanged board:`,
    ...(threats.length ? threats : [`No threatened ${own} non-king pieces.`]),
    `Legal castles now: ${castleIds}.`,
    "Recent 8 moves (oldest first):",
    ...(recent.length ? recent : ["none"]),
    "ALL LEGAL CARDS:",
    ...choices.map((choice) => choice.outcome),
    ...(focusCastling
      ? [
          "CASTLING CHECK BEFORE YOUR ANSWER:",
          `Prefer these castles over quiet moves, non-winning checks or equal trades: ${preferredCastles.map((move) => move.label).join(", ")}.`,
          "Override for mate, stopping mate, queen rescue, a free queen, or a clearly favorable capture or forcing gain. A losing exchange is not favorable."
        ]
      : []),
    ...positiveSafetySummaries({ game, moves, currentThreats }),
    ...(wins.length
      ? [
          "AVAILABLE IMMEDIATE OPPORTUNITIES:",
          `${own} can WIN THIS TURN with: ${wins.join(", ")}.${moves.some((move) => move.outcome.stalemate) ? " Choose a win; avoid STALEMATE (draw)." : ""}`
        ]
      : safeCaptures.length
        ? [
            "AVAILABLE IMMEDIATE OPPORTUNITIES:",
            `Prefer captures with no immediate legal recapture of the moved piece: ${safeCaptures.map((move) => move.label).join("; ")}. Checked replies show no net material loss or ${enemy} mate in one.`
          ]
        : []),
  ].join("\n")
  return {
    prompt: playerNames(prompt, game),
    choices: choices.map(choice => ({ ...choice, outcome: playerNames(choice.outcome, game) })),
    systemPrompt: systemPromptFor(game)
  }
}
