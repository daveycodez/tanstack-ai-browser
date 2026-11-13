import { createChatUI } from "@tanstack/ai-react/ui"

import { chatOptions } from "#/chat/options"
import { chatContext, interruptContext, partContext } from "#/chat/ui-context"
import { ConfirmDownload } from "./download-confirmation"
import { FallbackInterrupt } from "./fallback-interrupt"
import { FallbackPart } from "./fallback-part"
import { ChatPromptInput } from "./input"
import { ChatLayout } from "./layout"
import { everyTool, McpTool, McpToolApproval } from "./mcp-tool"
import { ChatMessage } from "./message"
import {
  AudioPart,
  DocumentPart,
  ImagePart,
  ToolResultPart,
  UIResourcePart,
  VideoPart
} from "./media-parts"
import { ChatQueueItem } from "./queue-item"
import { StructuredOutputPart } from "./structured-output"
import { TextPart } from "./text-part"
import { ThinkingPart } from "./thinking-part"
import { WeatherTool } from "./weather-tool"
import { LocationTool } from "./location-tool"
import { LOCATION_TOOL } from "#/lib/location"
import { WEATHER_TOOL } from "#/lib/weather"

/**
 * The chat kit, bound to this app's widgets. `createChatUI` rather than
 * `createChatHook`: each session calls useChat itself (see thread.tsx), to
 * give it the definitions of the MCP tools that ask first, which are only
 * known at runtime. `createChatHook` takes tools only in `chatOptions`.
 */
export const ChatUI = createChatUI(chatOptions, {
  context: {
    chatContext,
    partContext,
    interruptContext
  },
  components: {
    // `input` before `layout`, so the layout's props type includes `Input`.
    input: ChatPromptInput,
    layout: ChatLayout,
    message: ChatMessage,
    queue: ChatQueueItem
  },
  partsComponents: {
    text: TextPart,
    thinking: ThinkingPart,
    structuredOutput: StructuredOutputPart,
    image: ImagePart,
    audio: AudioPart,
    video: VideoPart,
    document: DocumentPart,
    toolResult: ToolResultPart,
    uiResource: UIResourcePart,
    fallback: FallbackPart
  },
  // MCP tools are only known at runtime: one widget for every tool name,
  // and their own for the built-in weather and location tools.
  toolsComponents: everyTool(McpTool, {
    [WEATHER_TOOL]: WeatherTool,
    [LOCATION_TOOL]: LocationTool
  }),
  interruptsComponents: {
    // A tool's approval shows in its call's own card (McpTool), so the
    // layout's `Interrupts` list shows nothing for one.
    tools: everyTool(McpToolApproval),
    // The app's own pauses, by their definition's id: asking before a
    // model downloads (chat/download-interrupt.ts).
    generic: { confirmDownload: ConfirmDownload, fallback: FallbackInterrupt }
  }
})

export const { useChatContext } = ChatUI
