import type { ContextGcConfig, GcPart, MessageWithParts } from "./types"
import { getBrainId } from "./brain-id-store"
import { compressToolOutput } from "./compressors/tool-output"
import { computeAssistantModifications } from "./compressors/assistant-response"
import { computeSystemModifications } from "./compressors/system-message"
import { buildToolCallMap } from "./pair-validator"
import { estimatePartsTokens } from "./tier-classifier"
import type { TierClassification } from "./tier-classifier"
import { isAlreadyCompressedAt, setCompressionTier } from "./compression-cache"

type ToolPartShape = {
  type: string
  tool?: string
  callID?: string
  state?: {
    status?: string
    output?: string
  }
}

type TextPartShape = {
  type: string
  text?: string
}

export type CompressStats = {
  toolOutputsCompressed: number
  thinkingBlocksRemoved: number
  textPartsCompressed: number
  systemPartsRemoved: number
  messagesRemoved: number
}

export const DEFAULT_MAX_GONE_PER_CYCLE = 5

function getBrainIdForMessage(
  sessionID: string,
  messageID: string,
): number | null {
  return getBrainId(sessionID, messageID)
}

export function compressMessages(
  messages: MessageWithParts[],
  classifications: TierClassification[],
  config: ContextGcConfig | undefined,
  tokensToFree: number,
): CompressStats {
  const maxGone = config?.max_gone_per_cycle ?? DEFAULT_MAX_GONE_PER_CYCLE
  const stats: CompressStats = {
    toolOutputsCompressed: 0,
    thinkingBlocksRemoved: 0,
    textPartsCompressed: 0,
    systemPartsRemoved: 0,
    messagesRemoved: 0,
  }

  let budgetRemaining = tokensToFree
  const removeIndices: number[] = []

  for (const classification of classifications) {
    if (classification.tier === "hot") {
      continue
    }

    if (budgetRemaining <= 0 && classification.tier !== "gone") {
      continue
    }

    if (classification.tier === "gone") {
      removeIndices.push(classification.messageIndex)
      continue
    }

    const msg = messages[classification.messageIndex]
    const info = msg.info
    const sessionID = info.sessionID ?? ""
    const messageID = info.id ?? ""

    // Skip if already compressed at this tier or deeper
    if (sessionID && messageID && (classification.tier === "warm" || classification.tier === "cold")) {
      if (isAlreadyCompressedAt(sessionID, messageID, classification.tier)) {
        continue
      }
    }

    const tokensBefore = estimatePartsTokens(msg.parts)

    const role = info.role ?? "unknown"
    const brainId = getBrainIdForMessage(sessionID, messageID)

    if (role === "assistant") {
      compressAssistantMessage(msg, classification, brainId, stats)
    } else if (role === "user") {
      compressUserMessage(msg, classification, brainId, stats)
    }

    const tokensAfter = estimatePartsTokens(msg.parts)
    const tokensFreed = tokensBefore - tokensAfter
    budgetRemaining -= tokensFreed

    // Record compression tier if we actually compressed something
    if (tokensFreed > 0 && sessionID && messageID && (classification.tier === "warm" || classification.tier === "cold")) {
      setCompressionTier(sessionID, messageID, classification.tier)
    }

  }

  if (removeIndices.length > 0) {
    const safeIndices = filterSafeRemovals(messages, removeIndices, maxGone)
    safeIndices.sort((a, b) => b - a)
    for (const idx of safeIndices) {
      messages.splice(idx, 1)
      stats.messagesRemoved++
    }
  }

  return stats
}

function filterSafeRemovals(
  messages: MessageWithParts[],
  removeIndices: number[],
  maxGone: number,
): number[] {
  const removeSet = new Set(removeIndices)

  // Expand removals to include tool pair partners
  const toolCallMap = buildToolCallMap(messages)
  for (const [, locations] of toolCallMap) {
    if (locations.length < 2) continue
    const anyRemoved = locations.some((loc) => removeSet.has(loc.messageIndex))
    if (anyRemoved) {
      for (const loc of locations) {
        removeSet.add(loc.messageIndex)
      }
    }
  }

  // Sort ascending (oldest first) and cap
  const sorted = [...removeSet].sort((a, b) => a - b).slice(0, maxGone)

  // Check original conversation's last role (before any removals)
  const originalLastRole = messages.length > 0
    ? (messages[messages.length - 1].info.role ?? "unknown")
    : "unknown"

  // If conversation already ends with assistant, removals can't make it worse
  if (originalLastRole === "assistant") {
    return sorted
  }

  // Our removals might expose a trailing assistant — trim from the end until safe
  const candidates = [...sorted]
  while (candidates.length > 0) {
    const removeFinal = new Set(candidates)
    let lastSurvivingRole = "unknown"
    for (let i = messages.length - 1; i >= 0; i--) {
      if (removeFinal.has(i)) continue
      lastSurvivingRole = messages[i].info.role ?? "unknown"
      break
    }

    if (lastSurvivingRole !== "assistant") {
      return candidates
    }

    // Last surviving is assistant — drop the last candidate (highest index) to try to fix
    candidates.pop()
  }

  return candidates
}

function compressAssistantMessage(
  msg: MessageWithParts,
  classification: TierClassification,
  brainId: number | null,
  stats: CompressStats,
): void {
  for (let pi = msg.parts.length - 1; pi >= 0; pi--) {
    const part = msg.parts[pi]
    const typed = part as GcPart as ToolPartShape

    if (typed.type === "tool" && typed.state?.output) {
      const result = compressToolOutput(
        typed.state.output,
        typed.tool ?? "unknown-tool",
        classification.tier,
        brainId,
      )
      if (result) {
        typed.state.output = result.compressed
        stats.toolOutputsCompressed++
      }
    }
  }

  const assistantMods = computeAssistantModifications(
    msg.parts,
    classification.tier,
    brainId,
  )

  for (let i = assistantMods.length - 1; i >= 0; i--) {
    const mod = assistantMods[i]
    if (mod.action === "remove") {
      msg.parts.splice(mod.partIndex, 1)
      stats.thinkingBlocksRemoved++
    } else if (mod.action === "replace" && mod.newText !== undefined) {
      const textPart = msg.parts[mod.partIndex] as GcPart as TextPartShape
      textPart.text = mod.newText
      stats.textPartsCompressed++
    }
  }
}

function compressUserMessage(
  msg: MessageWithParts,
  classification: TierClassification,
  brainId: number | null,
  stats: CompressStats,
): void {
  for (let pi = msg.parts.length - 1; pi >= 0; pi--) {
    const part = msg.parts[pi]
    const typed = part as GcPart as ToolPartShape

    if (typed.type === "tool" && typed.state?.output) {
      const result = compressToolOutput(
        typed.state.output,
        typed.tool ?? "unknown-tool",
        classification.tier,
        brainId,
      )
      if (result) {
        typed.state.output = result.compressed
        stats.toolOutputsCompressed++
      }
    }
  }

  const systemMods = computeSystemModifications(
    msg.parts,
    classification.tier,
  )

  for (let i = systemMods.length - 1; i >= 0; i--) {
    const mod = systemMods[i]
    if (mod.action === "remove") {
      msg.parts.splice(mod.partIndex, 1)
      stats.systemPartsRemoved++
    }
  }
}
