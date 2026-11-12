# Default tactical guidance

The default is `shared-v111-decoded-state-only`, the shared model-independent pipeline validated during the Chess experiments. LFM3 retains its existing weights and reasoning remains off by default. Every legal move stays in the strict output enum; warnings advise the model without vetoing a move or substituting an engine choice.

The production patch keeps bounded capture/recapture settlement, one extra opponent capture after a local recapture, checked quiet forks with legal defenses, explicit next-turn-mate action warnings, paired legal capture/net witnesses, one relevant worst-fork display and plain-language state metadata. Legacy v98/v99 builders remain available for regression comparisons. No Stockfish move or evaluation is used during gameplay.

The capture continuation distinguishes an equal local exchange from a later lost defender: `Bb3 Nxb3 cxb3 Qxd5` loses a pawn even though the bishop/knight trade is equal. The quiet-reply preview can flag `c3 Nc2+ Ke2 Nxa1` before the opponent has captured anything. Numeric costs describe their bounded preview, not whole-position evaluations. Incomplete proofs do not certify compensation. Capture and fork branches are alternatives; their costs are not added together.

The production default reproduced 96 recorded benchmark inputs and 33 head-to-head inputs byte-for-byte, including system text and every choice card. That profile recorded a Stockfish Skill-0/depth-1 win in a ten-game experiment (1 win, 7 losses, 2 unresolved caps) and a win as Black against GPT-6.1 Sol High with neutral inputs (33...Rc1#). Those observations are not a general strength or reliable win-rate estimate. Rejected experimental prompt variants, match bridges and reasoning diagnostics are excluded from this patch.

The benchmark now reports local teaching objectives separately from independent outcome review. Multiple sound plans qualify; uncertain choices stay diagnostic. The model is not required to reproduce one Stockfish move or one opening. See [the suite audit](SUITE-AUDIT.md) and [benchmark instructions](README.md).

## Compact wording and the search ceiling (v112)

The default is now `shared-v112-compact`: the v111 pipeline's moves, labels, order, warnings, squares and nets, in fewer words. A card says a capture once (`DANGER: bishop f5 takes knight h3, net -3` in place of the danger, its net and a one-capture exchange line repeating both), lists name moves by SAN alone, the recent moves drop their coordinates, and the system prompt states each rule once. Over the 272 positions of one recorded game and three random games the input is 36% shorter in characters (user prompt 39.5%, system prompt 24%). `shared-v111-decoded-state-only` stays selectable for matched comparisons.

Each candidate move's exchange and quiet-fork searches now share 600 positions; a search that runs out publishes no result, as any incomplete one. Without it a late middlegame turn's analysis visited tens of thousands of positions. On those 272 positions the ceiling changes 14 prompts.

Neither change has been through the model benchmark: the v111 results above describe v111's wording and unbounded searches. Run the matched comparison (v111 against v112) before relying on them for the new default.
