import {
  buildSharedPrompt as buildV98,
  systemPromptFor as systemV98
} from "./shared-prompt-v98.ts"
import type { SharedPromptInput } from "./shared-prompt-v98.ts"
import { concise } from "./shared-prompt-v99.ts"
import { squareName } from "./chess.ts"

const mateSafetyRule =
  "If no immediate CHECKMATE wins now, avoid moves marked LOSS NEXT TURN whenever another move avoids that loss. Material gains cannot compensate for checkmate."
function withMateSafety(text: string): string {
  return text.replace("\n\nBOARD NOW", `\n\n${mateSafetyRule}\n\nBOARD NOW`)
}

function dangerSystem(text: string): string {
  return (
    withMateSafety(text) +
    "\n\nLOSE NEXT TURN labels mean your opponent can checkmate immediately. All moves remain legal choices. CHECKED EXCHANGE continues legal captures on the exchange square; quiet follow-ups beyond that exchange are not evaluated."
  )
}

function decodedState(game: SharedPromptInput["game"]): string {
  const [, turn, rights, ep, halfmove, fullmove] = game.fen.split(" ")
  const own = game.humanColor === "white" ? "b" : "w"
  const describeRights = (color: string) => {
    const flags = color === "w" ? ["K", "Q"] : ["k", "q"]
    return (
      flags
        .flatMap((flag, i) =>
          rights.includes(flag) ? [i ? "queenside" : "kingside"] : []
        )
        .join(" and ") || "none"
    )
  }
  return `Turn: ${turn === own ? "you" : "opponent"}. Retained castling rights (not current legality): you ${describeRights(own)}; opponent ${describeRights(own === "w" ? "b" : "w")}. En-passant target: ${ep === "-" ? "none" : ep}. Halfmove clock: ${halfmove}; fullmove number: ${fullmove}.`
}

function forkRiskSystem(text: string): string {
  return (
    text +
    "\n\nRISK labels include both immediate capture losses and completed bounded quiet-fork previews. The more negative net is shown; it is not a whole-position evaluation. Compare these risks before a small material gain. Every listed move remains selectable."
  )
}
function postExchangeSystem(text: string): string {
  return text
    .replace(
      "CHECKED EXCHANGE continues legal captures on the exchange square; quiet follow-ups beyond that exchange are not evaluated.",
      "CHECKED EXCHANGE can continue with one further opponent capture after your local recapture, then local recaptures on the new square. Quiet moves are not searched. An incomplete preview does not certify compensation."
    )
    .replace("immediate capture losses", "capture-exchange losses")
}
function pairedCaptureSystem(text: string): string {
  return (
    text +
    "\n\nA displayed CHECKED EXCHANGE net belongs to that line and illustrates one worst capture branch on its card. Capture and fork lines are separate possible opponent branches; do not add their losses together."
  )
}
function forkRiskPrompt(
  input: SharedPromptInput,
  {
    postExchange = false,
    pairedCaptures = false,
    compactForks = false,
    preferCaptures = false
  }: {
    postExchange?: boolean
    pairedCaptures?: boolean
    compactForks?: boolean
    preferCaptures?: boolean
  } = {}
): ReturnType<typeof buildV98> {
  type AnalyzedMove = SharedPromptInput["moves"][number]
  type Fork = NonNullable<AnalyzedMove["outcome"]["quietForkThreats"]>[number]
  const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
  const captureNetOf = (move: AnalyzedMove) =>
    Math.min(
      0,
      ...(
        move.outcome.replyMaterialLosses ??
        move.outcome.replyMajorLosses ??
        []
      ).map((loss) => loss.netMaterial)
    )
  const forkTotal = (move: AnalyzedMove, fork: Fork) => {
    const initialGain =
      (move.captured ? values[move.captured] : 0) +
      (move.promotion ? values[move.promotion] - values.p : 0)
    const promotion = fork.replyId[4]
    const promotionCost =
      promotion === "q" ||
      promotion === "r" ||
      promotion === "b" ||
      promotion === "n"
        ? values[promotion] - values.p
        : 0
    return fork.responseNet === undefined
      ? 0
      : initialGain - promotionCost + fork.responseNet
  }
  const forkNet = (move: AnalyzedMove) =>
    Math.min(
      0,
      ...(move.outcome.quietForkThreats ?? []).map((fork) =>
        forkTotal(move, fork)
      )
    )
  const shownForks = new Map<string, { fork: Fork; net: number }>()
  if (compactForks)
    for (const move of input.moves) {
      if (
        move.outcome.allowsMateInOne ||
        move.outcome.checkmate ||
        move.outcome.drawReason
      )
        continue
      let worst: { fork: Fork; net: number } | undefined
      for (const fork of move.outcome.quietForkThreats ?? []) {
        if (fork.responseNet === undefined) continue
        const net = forkTotal(move, fork)
        if (net < captureNetOf(move) && (!worst || net < worst.net))
          worst = { fork, net }
      }
      if (worst) shownForks.set(move.id, worst)
    }
  // This is a presentation view only. Labels and summaries below use every
  // original evaluated threat, including those whose detail is not displayed.
  const displayInput = compactForks
    ? {
        ...input,
        moves: input.moves.map((move) => {
          const shown = shownForks.get(move.id)
          return {
            ...move,
            outcome: {
              ...move.outcome,
              ...(move.outcome.quietForkThreats
                ? { quietForkThreats: shown ? [shown.fork] : [] }
                : {})
            }
          }
        })
      }
    : input
  const base = checkedForkPrompt(displayInput)
  const byId = new Map(input.moves.map((move) => [move.id, move]))
  const moveForId = (id: string) => {
    const move = byId.get(id)
    if (!move) throw new Error("A legal fork-risk card has no matching move.")
    return move
  }
  const replacements = new Map<string, string>()
  const labels = new Map<string, string>()
  const zeroKnownLoss = (move: AnalyzedMove) =>
    !move.outcome.allowsMateInOne &&
    !move.outcome.exchangeFollowupUnresolved &&
    move.outcome.replyMaterialLosses?.length === 0 &&
    forkNet(move) === 0 &&
    !move.outcome.promotionReplies?.some(
      (reply) =>
        reply.checkmate ||
        Math.max(
          reply.netAfterPromotion,
          reply.netAfterImmediateCapture ?? -Infinity
        ) < 0
    )
  const choices = base.choices.map((choice) => {
    const move = moveForId(choice.id)
    const captureNet = captureNetOf(move)
    const net = Math.min(captureNet, forkNet(move))
    const label =
      forkNet(move) < 0 &&
      !move.outcome.checkmate &&
      !move.outcome.drawReason &&
      !move.outcome.allowsMateInOne
        ? `RISK ${net}: ${move.notation}`
        : choice.label
    let outcome = label + choice.outcome.slice(choice.label.length)
    if (postExchange) {
      outcome = outcome.replaceAll(
        "possible net next turn",
        "possible exchange net"
      )
      if (move.outcome.exchangeFollowupUnresolved)
        outcome =
          outcome.replaceAll("COMPENSATING RECAPTURE", "UNRESOLVED EXCHANGE") +
          "; post-exchange capture preview incomplete"
    }
    if (pairedCaptures) {
      const losses =
        move.outcome.replyMaterialLosses ?? move.outcome.replyMajorLosses ?? []
      const worst = Math.min(0, ...losses.map((loss) => loss.netMaterial))
      const explained = losses.find(
        (loss) => loss.netMaterial === worst && loss.exchangeLine?.length
      )
      const witness = explained
        ? `; CHECKED EXCHANGE net ${explained.netMaterial}: ${explained.exchangeLine?.map((san, index) => `${index % 2 ? "you" : "opponent"} ${san}`).join(", ")}`
        : ""
      // Never attach a lesser exchange to an unrelated, larger capture warning.
      outcome = outcome.replace(/; CHECKED EXCHANGE [^;]+/, witness)
    }
    const shown = shownForks.get(move.id)
    if (compactForks && shown)
      outcome = outcome.replace(
        `best checked response net ${shown.fork.responseNet}`,
        `overall fork net ${shown.net}`
      )
    replacements.set(choice.outcome, outcome)
    labels.set(choice.label, label)
    return { ...choice, label, outcome }
  })
  let prompt = base.prompt
    .split("\n")
    .map(
      (line) =>
        replacements.get(line) ??
        line.replace(
          /^(.*(?:CHOICES: |with: |equal trades: |MATERIAL-SAFE\): ))([^.]*)\.(.*)$/,
          (_match, head: string, list: string, tail: string) =>
            head +
            list
              .split(/(, |; )/)
              .map((label) => labels.get(label) ?? label)
              .join("") +
            "." +
            tail
        )
    )
    .join("\n")
  if (
    (input.moves.some((move) => forkNet(move) < 0) ||
      (postExchange &&
        input.moves.some((move) => move.outcome.exchangeFollowupUnresolved))) &&
    !input.moves.some((move) => move.outcome.checkmate)
  ) {
    // Replace the capture-only whitelist, not the full legal-action list.
    prompt = prompt
      .split("\n")
      .filter(
        (line) =>
          !line.startsWith("MATERIAL-SAFE CHOICES:") &&
          !line.startsWith(
            "Within king/queen-safe choices prefer MATERIAL-SAFE"
          ) &&
          !line.startsWith("After king/queen safety choose MATERIAL-SAFE") &&
          !line.startsWith(
            "Prefer safe captures (KING-SAFE and MATERIAL-SAFE):"
          ) &&
          !(preferCaptures && line === "AVAILABLE IMMEDIATE OPPORTUNITIES:")
      )
      .join("\n")
    const safe = choices.filter((choice) => {
      const move = moveForId(choice.id)
      return zeroKnownLoss(move)
    })
    prompt = prompt
      .replaceAll(
        "KING-SAFE CHOICES:",
        "NO IMMEDIATE MATE OR MAJOR-CAPTURE LOSS:"
      )
      .replace(
        "Choose KING-SAFE; within that set prefer safe captures/forcing gains over quiet moves.",
        "Compare immediate mate prevention with capture and fork risks before material gains."
      )
      .replace(
        "MATERIAL-SAFE only describes the earlier capture-only preview.",
        "The final summary also checks the completed fork responses."
      )
    prompt += `\nCAPTURE AND FORK PREVIEW: ${safe.length ? safe.map((choice) => choice.label).join(", ") : "no zero-loss choice found"}. No losing net found in evaluated captures or completed fork responses for these choices. Later quiet play and incomplete ${postExchange ? "exchange or fork" : "fork"} responses are not certified. Compare king safety and development too.`
    if (preferCaptures) {
      const captures = safe.filter((choice) => {
        const move = moveForId(choice.id)
        return (
          move.captured &&
          move.captured !== "k" &&
          move.outcome.recapture.count === 0 &&
          !move.outcome.checkmate &&
          !move.outcome.stalemate &&
          !move.outcome.drawReason
        )
      })
      if (captures.length)
        prompt += `\nAVAILABLE SAFE CAPTURES:\nPrefer safe captures from this checked capture/fork preview: ${captures.map((choice) => choice.label).join("; ")}. Follow the king/queen safety and forcing-gain priorities above.`
    }
  }
  if (compactForks)
    prompt = prompt.replace(
      /^CHECKED FORK NET: [^\n]+$/m,
      "FORK PREVIEW: only a worst fork showing a larger loss than the capture preview is displayed. Its overall net includes your move and the shown continuation. Immediate defenses and captures were checked; later quiet play is not searched."
    )
  const systemPrompt = postExchange
    ? postExchangeSystem(forkRiskSystem(base.systemPrompt))
    : forkRiskSystem(base.systemPrompt)
  return {
    ...base,
    choices,
    prompt,
    systemPrompt: pairedCaptures
      ? pairedCaptureSystem(systemPrompt)
      : systemPrompt
  }
}

function decodedMetadataSystem(text: string): string {
  return text.replace(
    "Use decoded board/outcomes; FEN is audit data.",
    "Use the supplied current board and decoded state as facts."
  )
}

/** Private base for the validated tactical presentation. */
function checkedForkPrompt(
  input: SharedPromptInput
): ReturnType<typeof buildV98> {
  const base = buildV98(input),
    rows = new Map<string, string>()
  const choices = base.choices.map((choice) => {
    let outcome = concise(choice.outcome),
      label = choice.label
    const move = input.moves.find((move) => move.id === choice.id)
    if (move?.outcome.allowsMateInOne && !move.outcome.checkmate)
      label = `LOSE NEXT TURN: ${label}`
    if (label !== choice.label)
      outcome = label + outcome.slice(choice.label.length)
    const loss = move?.outcome.replyMaterialLosses
      ?.filter((loss) => loss.exchangeLine)
      .sort((a, b) => a.netMaterial - b.netMaterial)[0]
    if (loss?.exchangeLine)
      outcome += `; CHECKED EXCHANGE ${loss.exchangeLine.map((san, index) => `${index % 2 ? "you" : "opponent"} ${san}`).join(", ")}`
    const names = {
      k: "king",
      q: "queen",
      r: "rook",
      b: "bishop",
      n: "knight",
      p: "pawn"
    }
    for (const fork of move?.outcome.quietForkThreats ?? []) {
      const targets = fork.targets
        .map(
          (target) => `your ${names[target.piece]} ${squareName(target.square)}`
        )
        .join(" and ")
      if (fork.responseNet !== undefined) {
        outcome += `; CHECKED QUIET FORK: opponent ${fork.replyNotation} attacks ${targets}; best checked response net ${fork.responseNet}; ${fork.responseLine?.map((san, index) => `${index % 2 ? "you" : "opponent"} ${san}`).join(", ")}`
        continue
      }
      const defense =
        fork.captureDefense === "none"
          ? "no immediate legal capture of the attacker"
          : fork.captureDefense === "losing"
            ? `checked capture reply ${fork.captureLine?.join(" ")}, net ${fork.captureNet}`
            : "capture safety unresolved within the bounded exchange check"
      outcome += `; QUIET FORK: opponent ${fork.replyNotation} attacks ${targets}; ${defense}`
    }
    rows.set(choice.outcome, outcome)
    return { ...choice, label, outcome }
  })
  let prompt = base.prompt
    .split("\n")
    .map((line) => rows.get(line) ?? concise(line))
    .join("\n")
  if (input.moves.some((move) => move.outcome.quietForkThreats?.length))
    prompt = prompt.replace(
      "NEXT MOVE OPTIONS:",
      "CHECKED FORK NET: every legal immediate defense was checked, followed by legal opponent captures and bounded recaptures. A negative net is material cost in that preview, not an overall position score. Later quiet continuations are not searched. MATERIAL-SAFE only describes the earlier capture-only preview.\nNEXT MOVE OPTIONS:"
    )
  if (
    input.moves.some((move) => move.outcome.allowsMateInOne) &&
    input.moves.some((move) => !move.outcome.allowsMateInOne)
  )
    prompt +=
      "\nFINAL SAFETY CHECK: LOSS NEXT TURN means your opponent can checkmate you immediately. Choose a move without that warning; a capture cannot compensate for losing the game."
  return {
    ...base,
    choices,
    prompt,
    systemPrompt: dangerSystem(concise(base.systemPrompt))
  }
}
export function tacticalSystemPromptFor(
  game: Pick<SharedPromptInput["game"], "humanColor">
): string {
  return decodedMetadataSystem(
    pairedCaptureSystem(
      postExchangeSystem(forkRiskSystem(dangerSystem(concise(systemV98(game)))))
    )
  )
}
export function buildTacticalPrompt(
  input: SharedPromptInput
): ReturnType<typeof buildV98> {
  const result = forkRiskPrompt(input, {
    postExchange: true,
    pairedCaptures: true,
    compactForks: true,
    preferCaptures: true
  })
  return {
    ...result,
    prompt: result.prompt.replace(
      /^FEN state \(turn\/castling\/en-passant\/halfmove\/fullmove\): .+$/m,
      decodedState(input.game)
    ),
    systemPrompt: decodedMetadataSystem(result.systemPrompt)
  }
}
