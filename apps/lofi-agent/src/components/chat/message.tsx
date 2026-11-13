/**
 * The `message` widget. A user message can be edited and sent again; an
 * assistant message shows its parts (thinking, tool calls, the answer)
 * through the kit's `Parts`, then its sources and actions. The layout
 * follows assistant-ui's thread (MIT, github.com/assistant-ui/assistant-ui).
 */
import ArrowDownToLine from "@gravity-ui/icons/ArrowDownToLine"
import ArrowRotateRight from "@gravity-ui/icons/ArrowRotateRight"
import Check from "@gravity-ui/icons/Check"
import Copy from "@gravity-ui/icons/Copy"
import Ellipsis from "@gravity-ui/icons/Ellipsis"
import Pencil from "@gravity-ui/icons/Pencil"
import TrashBin from "@gravity-ui/icons/TrashBin"
import Volume from "@gravity-ui/icons/Volume"
import VolumeXmark from "@gravity-ui/icons/VolumeXmark"
import { Alert, Button, Dropdown, Label } from "@heroui/react"
import type { ContentPart, UIMessage } from "@tanstack/ai"
import type { MessageProps } from "@tanstack/ai-react/ui"
import { useContext, useEffect, useMemo, useState } from "react"

import { attachmentPart, toAttachments } from "#/chat/attachments"
import { useSelectedModel } from "#/chat/model"
import { modelInfo, useAttachableKinds, useModelStatus } from "#/chat/models"
import type { chatOptions } from "#/chat/options"
import { Action, Actions } from "#/components/ai/actions"
import {
  AttachmentChip,
  PromptInputAddAttachment,
  PromptInputAttachments
} from "#/components/ai/attachments"
import { Message, MessageContent } from "#/components/ai/message"
import { ToolGroup } from "#/components/ai/tool"
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputToolbar
} from "#/components/ai/prompt-input"
import { SourceList } from "#/components/ai/sources"
import { TimeAgo } from "#/components/ai/time-ago"
import { messageText } from "#/lib/reply-sources"
import { useCallsAsking } from "./mcp-tool"
import { ReplyContext, TranscriptContext, useThread } from "./thread-context"
import { ChatUI, useChatContext } from "./ui-components"

/**
 * The `message` widget. An assistant message lays out its parts itself
 * (see MessageParts), so the kit's `Parts` isn't used.
 */
export function ChatMessage({ message }: MessageProps<typeof chatOptions>) {
  if (message.role === "user") return <UserMessage message={message} />
  if (message.role === "assistant") {
    return <AssistantMessage message={message} />
  }
  return null
}

/** A user message's images and audio, as content parts to send again. */
const mediaParts = (message: UIMessage): Array<ContentPart> =>
  message.parts.flatMap((part) => (part.type === "image" || part.type === "audio" ? [part as ContentPart] : []))

/** A media part's source as a URL, or nothing for a provider file. */
const mediaSrc = (source: { type: string; value: string; mimeType?: string }) =>
  source.type === "file" ? undefined : source.type === "data" ? `data:${source.mimeType ?? "application/octet-stream"};base64,${source.value}` : source.value

/** A media part's file name, as the composer saved it; a part without one is numbered. */
const mediaName = (part: ContentPart, index: number) => {
  const saved = (part.metadata as { name?: unknown } | undefined)?.name
  return typeof saved === "string" && saved ? saved : `${part.type === "image" ? "Image" : "Audio"} ${index + 1}`
}

function UserMessage({ message }: { message: UIMessage }) {
  const { messages } = useChatContext()
  const { resend, remove } = useThread()
  const [isEditing, setIsEditing] = useState(false)
  const text = messageText(message)
  const media = mediaParts(message)
  // The images and audio left after editing go again with the text.
  const content = (next: string, parts: Array<ContentPart>) =>
    parts.length ? [...parts, ...(next ? [{ type: "text" as const, content: next }] : [])] : next

  if (isEditing) {
    return (
      <EditMessage
        initial={text}
        media={media}
        onCancel={() => setIsEditing(false)}
        onUpdate={(next, parts) => {
          setIsEditing(false)
          resend(
            messages.findIndex((m) => m.id === message.id),
            content(next, parts)
          )
        }}
        onDelete={() => {
          setIsEditing(false)
          remove(message.id)
        }}
      />
    )
  }

  return (
    <Message from="user">
      {media.length > 0 && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-2">
          {media.map((part, index) => {
            if (part.type !== "image" && part.type !== "audio") return null
            const src = mediaSrc(part.source as { type: string; value: string; mimeType?: string })
            return src ? <AttachmentChip key={index} kind={part.type} src={src} name={mediaName(part, index)} /> : null
          })}
        </div>
      )}
      {text && <MessageContent>{text}</MessageContent>}
      <Actions>
        {message.createdAt && <TimeAgo date={new Date(message.createdAt)} before />}
        <CopyAction text={text} />
        <Action
          label="Regenerate"
          onPress={() =>
            resend(
              messages.findIndex((m) => m.id === message.id),
              content(text, media)
            )
          }
        >
          <ArrowRotateRight />
        </Action>
        <Action label="Edit" onPress={() => setIsEditing(true)}>
          <Pencil />
        </Action>
      </Actions>
    </Message>
  )
}

/** A user message being edited, in a prompt input of its own. */
function EditMessage({
  initial,
  media,
  onCancel,
  onUpdate,
  onDelete
}: {
  initial: string
  media: ReadonlyArray<ContentPart>
  onCancel: () => void
  onUpdate: (text: string, media: Array<ContentPart>) => void
  onDelete: () => void
}) {
  const [value, setValue] = useState(initial)
  // The message's images and audio, each with a key: removed here, or added to.
  const [parts, setParts] = useState<Array<{ id: string; part: ContentPart }>>(() =>
    media.map((part) => ({ id: crypto.randomUUID(), part }))
  )
  // What the picked model reads, as in the message input.
  const kinds = useAttachableKinds(useSelectedModel())
  const attach = (files: Iterable<File>) => {
    void toAttachments(files, kinds).then(({ attachments }) =>
      setParts((current) => [...current, ...attachments.map((attachment) => ({ id: attachment.id, part: attachmentPart(attachment) }))])
    )
  }
  return (
    <PromptInput label="Edit message" className="ms-auto w-full max-w-[85%]">
      <PromptInputAttachments
        attachments={parts.flatMap(({ id, part }, index) => {
          if (part.type !== "image" && part.type !== "audio") return []
          const src = mediaSrc(part.source as { type: string; value: string; mimeType?: string })
          return src ? [{ id, kind: part.type, name: mediaName(part, index), src }] : []
        })}
        onRemove={(id) => setParts((current) => current.filter((item) => item.id !== id))}
      />
      <PromptInputTextarea
        value={value}
        maxRows={13}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter((file) => kinds.some((kind) => file.type.startsWith(`${kind}/`)))
          if (files.length === 0) return
          e.preventDefault()
          attach(files)
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel()
        }}
      />
      <PromptInputToolbar>
        {kinds.length > 0 && <PromptInputAddAttachment kinds={kinds} onAdd={attach} />}
        <Button size="sm" variant="danger" onPress={onDelete}>
          Delete
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onPress={onCancel}
          className="ms-auto"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          isDisabled={!value.trim() && parts.length === 0}
          onPress={() => onUpdate(value.trim(), parts.map((item) => item.part))}
        >
          Update
        </Button>
      </PromptInputToolbar>
    </PromptInput>
  )
}

/**
 * Whether a reply's last step ended in a tool's result: the model reads it
 * and goes on in a new message, so this one is complete.
 */
export const awaitsNextStep = (message: UIMessage) => {
  const last = message.parts.at(-1)
  return last?.type === "tool-result" || (last?.type === "tool-call" && last.output !== undefined)
}

/** Between a message's thinking parts' text, joined: a character no model writes. */
const THOUGHT_BREAK = "\u0000"

function AssistantMessage({ message }: { message: UIMessage }) {
  const { messages, isLoading, error, reload } = useChatContext()
  const { remove } = useThread()
  const sources = useContext(TranscriptContext).get(message.id)
  const index = messages.findIndex((m) => m.id === message.id)
  const isLast = index === messages.length - 1
  const isRunning = isLoading && isLast
  const text = messageText(message)
  const hasTools = message.parts.some((p) => p.type === "tool-call")
  const hasThinking = message.parts.some(
    (p) => p.type === "thinking" && p.content.trim()
  )
  const hasAnswer = !!text || hasTools
  // After a tool's result the model reads it and writes on in a new message
  // (the layout shows what it's doing there), so this one is laid out as
  // finished: nothing in it moves when the next one starts.
  const last = message.parts.at(-1)
  const isWriting = isRunning && !awaitsNextStep(message)
  const shownError = isLast && !isLoading ? error : undefined

  const liveThinking =
    isWriting && last?.type === "thinking" ? last.content : undefined
  // Its thinking parts' text, read on every render (a streaming part grows
  // in place) and joined, so the context only changes when the text does.
  const thoughts = message.parts.flatMap((p) => (p.type === "thinking" ? [p.content] : [])).join(THOUGHT_BREAK)
  const reply = useMemo(
    () => ({
      sources,
      isRunning,
      hasAnswer,
      liveThinking,
      messageId: message.id,
      thinking: thoughts ? thoughts.split(THOUGHT_BREAK) : []
    }),
    [sources, isRunning, hasAnswer, liveThinking, message.id, thoughts]
  )

  return (
    <Message from="assistant">
      <ReplyContext.Provider value={reply}>
        <MessageParts message={message} />
      </ReplyContext.Provider>
      {isWriting && !hasAnswer && !hasThinking && <Working />}
      {text && sources && sources.all.length > 0 && (
        <SourceList sources={sources.all} />
      )}
      {shownError && <ErrorAlert error={shownError} />}
      {!isWriting && (text || shownError) && (
        <ReplyActions
          text={text}
          canRegenerate={isLast && !isRunning}
          createdAt={message.createdAt}
          onReload={() => void reload()}
          onDelete={() => remove(message.id)}
        />
      )}
    </Message>
  )
}

type SelectedPart = Parameters<typeof ChatUI.Part>[0]["part"] & {
  key: string
}

/** A tool call part's id; nothing for another part. */
const callId = (part: SelectedPart) =>
  part.key === "toolCall" ? (part as { part?: { id?: string } }).part?.id : undefined

/**
 * An assistant message's parts, as the kit renders them, with each run of
 * two or more tool calls gathered under one "N tool calls" accordion. A tool result
 * that belongs to a call shows in the call, as the kit's own `Parts` does.
 * A call that waits for approval stands on its own, so its question shows:
 * a group opens collapsed.
 */
function MessageParts({ message }: { message: UIMessage }) {
  const asking = useCallsAsking()
  const asks = (part: SelectedPart | undefined) => {
    const id = part && callId(part)
    return id !== undefined && asking.has(id)
  }
  return (
    <ChatUI.Message message={message}>
      {(parts) => {
        const shown = (parts as Array<SelectedPart>).filter(
          (p) => !(p.key === "toolResult" && "matched" in p && p.matched)
        )
        const groups: Array<Array<SelectedPart>> = []
        for (const part of shown) {
          const last = groups.at(-1)
          if (part.key === "toolCall" && last?.[0]?.key === "toolCall" && !asks(part) && !asks(last[0])) {
            last.push(part)
          } else {
            groups.push([part])
          }
        }
        return groups.map((group, i) =>
          group[0]?.key === "toolCall" && group.length > 1 ? (
            <ToolGroup key={i} count={group.length}>
              {group.map((part, j) => (
                <ChatUI.Part key={j} part={part} />
              ))}
            </ToolGroup>
          ) : (
            group.map((part, j) => <ChatUI.Part key={`${i}-${j}`} part={part} />)
          )
        )
      }}
    </ChatUI.Message>
  )
}

/**
 * The reply before its first token arrives: to the last user message, or
 * the next step of one that just used a tool. After a failed run, the error.
 */
export function PendingReply() {
  const { isLoading, error, reload } = useChatContext()
  return (
    <Message from="assistant">
      {isLoading && <Working />}
      {!isLoading && error && (
        <>
          <ErrorAlert error={error} />
          <ReplyActions text="" canRegenerate onReload={() => void reload()} />
        </>
      )}
    </Message>
  )
}

/**
 * What the model is doing until it writes, shimmering like "Thinking…": a
 * model downloads when the first message is sent to it (which model, and
 * how much of it is here), then loads into memory; after that it reads the
 * prompt, as it does on every turn and after every tool result.
 */
function Working() {
  const model = useSelectedModel()
  const status = useModelStatus(model)
  const loading = status.state === "loading" ? status : null
  const downloading =
    loading && loading.downloading && loading.progress < 1 ? loading : null
  const label = downloading
    ? `Downloading ${modelInfo(model).name}… ${Math.round(downloading.progress * 100)}%`
    : loading
      ? "Loading…"
      : "Processing…"
  // The reply's own text box (and the Thoughts toggle's line), so the label
  // sits exactly where the reply's first line will and nothing moves when
  // the reply takes its place.
  return (
    <div className="markdown markdown-muted prose prose-sm max-w-none">
      <p>
        <span className="text-shimmer">{label}</span>
      </p>
    </div>
  )
}

function ErrorAlert({ error }: { error: Error }) {
  return (
    <Alert status="danger">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{error.message}</Alert.Description>
      </Alert.Content>
    </Alert>
  )
}

function ReplyActions({
  text,
  canRegenerate,
  createdAt,
  onReload,
  onDelete
}: {
  text: string
  canRegenerate: boolean
  /** When the reply was written, shown as "N minutes ago". */
  createdAt?: Date | string
  onReload: () => void
  onDelete?: () => void
}) {
  return (
    <Actions>
      {text && <CopyAction text={text} />}
      {text && <ReadAloudAction text={text} />}
      {canRegenerate && (
        <Action label="Regenerate" onPress={onReload}>
          <ArrowRotateRight />
        </Action>
      )}
      {text && (
        <Dropdown>
          <Action label="More">
            <Ellipsis />
          </Action>
          <Dropdown.Popover placement="bottom start">
            <Dropdown.Menu
              onAction={(key) => {
                if (key === "export") downloadMarkdown(text)
                if (key === "delete") onDelete?.()
              }}
            >
              <Dropdown.Item id="export" textValue="Export as Markdown">
                <ArrowDownToLine className="size-4" />
                <Label>Export as Markdown</Label>
              </Dropdown.Item>
              <Dropdown.Item id="delete" textValue="Delete" variant="danger">
                <TrashBin className="size-4 text-danger" />
                <Label>Delete</Label>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      )}
      {createdAt && <TimeAgo date={new Date(createdAt)} />}
    </Actions>
  )
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <Action
      label={copied ? "Copied" : "Copy"}
      onPress={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Action>
  )
}

/** Reads the reply with the browser's built-in, on-device speech. */
function ReadAloudAction({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false)
  useEffect(() => () => window.speechSynthesis?.cancel(), [])
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return null
  }
  return (
    <Action
      label={speaking ? "Stop" : "Read aloud"}
      onPress={() => {
        window.speechSynthesis.cancel()
        if (speaking) {
          setSpeaking(false)
          return
        }
        const utterance = new SpeechSynthesisUtterance(
          text.replace(/[*_`#>]/g, "")
        )
        utterance.onend = () => setSpeaking(false)
        utterance.onerror = () => setSpeaking(false)
        setSpeaking(true)
        window.speechSynthesis.speak(utterance)
      }}
    >
      {speaking ? <VolumeXmark /> : <Volume />}
    </Action>
  )
}

function downloadMarkdown(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }))
  const a = document.createElement("a")
  a.href = url
  a.download = "message.md"
  a.click()
  URL.revokeObjectURL(url)
}
