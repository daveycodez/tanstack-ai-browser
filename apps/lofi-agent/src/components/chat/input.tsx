/**
 * The `input` widget: the prompt input, with attached images and audio above its
 * text, and the plus button, the model picker (and its thinking effort) and
 * voice input in its toolbar.
 */
import Microphone from "@gravity-ui/icons/Microphone"
import { Alert, Skeleton } from "@heroui/react"
import type { ContentPart, ReasoningLevel } from "@tanstack/ai"
import { useRef, useState } from "react"

import {
  setEffort,
  setSelectedModel,
  useEffort,
  useSelectedModel
} from "#/chat/model"
import { cantRead, unreadableKinds } from "#/chat/media"
import {
  afmStatus,
  checkAfm,
  effortButtonLabel,
  effortFor,
  effortOptions,
  PROVIDERS,
  attachableKinds,
  inputModalities,
  modelInfo,
  useBackends,
  useModels
} from "#/chat/models"
import type { ModelId } from "#/chat/models"
import { Action } from "#/components/ai/actions"
import {
  PromptInputAddAttachment,
  PromptInputAttachments,
  toAttachments
} from "#/components/ai/attachments"
import { ModelSelector } from "#/components/ai/model-selector"
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools
} from "#/components/ai/prompt-input"
import { useDictation } from "#/lib/dictation"
import { AppleSetupModal } from "./apple-setup-modal"
import { useComposer, useThread } from "./thread-context"
import { useChatContext } from "./ui-components"

export function ChatPromptInput() {
  const { value, setValue, attachments, setAttachments } = useComposer()
  const { send } = useThread()
  const { isLoading, stop } = useChatContext()
  const model = useSelectedModel()
  const kinds = attachableKinds(model)
  // Attachments the picked model can't read, after a switch: the draft
  // stays as it is, and won't send until they're removed or another model
  // is picked.
  const unreadable = unreadableKinds(
    attachments.map((attachment) => ({ type: attachment.kind })),
    inputModalities(model)
  )
  const hasDraft = !!value.trim() || attachments.length > 0
  // A message sent while a reply runs waits in the queue.
  const canSend = hasDraft && unreadable.length === 0
  const attach = (files: Iterable<File>) => {
    void toAttachments(files, kinds).then((added) => setAttachments((current) => [...current, ...added]))
  }

  // Dictation adds to whatever was already typed when it started.
  const dictation = useDictation()
  const toggleDictation = () => {
    if (dictation.isListening) return dictation.stop()
    const before = value.trimEnd()
    dictation.start((text) =>
      setValue(before ? `${before} ${text.trimStart()}` : text.trimStart())
    )
  }

  const submit = () => {
    if (!canSend) return
    dictation.cancel()
    const text = value.trim()
    // Attachments first, then the text, as a model reads a picture or clip and its question.
    const media: Array<ContentPart> = attachments.map((attachment) => ({
      type: attachment.kind,
      source: { type: "data", value: attachment.data, mimeType: attachment.mimeType }
    }))
    send(media.length ? [...media, ...(text ? [{ type: "text" as const, content: text }] : [])] : text)
    setValue("")
    setAttachments(() => [])
  }

  return (
    <>
      {unreadable.length > 0 && (
        // Above the box, not in it.
        <Alert status="danger" className="mb-2">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              {cantRead(modelInfo(model).name, unreadable)} Pick a model that can, or remove them to send.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      <PromptInput label="Message input" name="message">
        <PromptInputAttachments
          attachments={attachments}
          onRemove={(id) => setAttachments((current) => current.filter((a) => a.id !== id))}
        />
        <PromptInputTextarea
          placeholder="Send a message..."
          value={value}
          enterKeyHint="send"
          onChange={(e) => setValue(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((file) => kinds.some((kind) => file.type.startsWith(`${kind}/`)))
            if (files.length === 0) return
            e.preventDefault()
            attach(files)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <PromptInputToolbar>
          <PromptInputTools>
            {kinds.length > 0 && <PromptInputAddAttachment kinds={kinds} onAdd={attach} />}
            <ChatModelSelector />
          </PromptInputTools>
          <PromptInputTools end>
            {dictation.isSupported && (
              <Action
                label={
                  dictation.isListening ? "Stop voice input" : "Start voice input"
                }
                aria-pressed={dictation.isListening}
                onPress={toggleDictation}
                className={dictation.isListening ? "text-danger" : "text-muted"}
              >
                <Microphone />
              </Action>
            )}
            <PromptInputSubmit
              // Stop while a reply runs, until there's a message to queue.
              status={isLoading && !hasDraft ? "streaming" : "ready"}
              isDisabled={!canSend}
              onSubmit={submit}
              onStop={stop}
            />
          </PromptInputTools>
        </PromptInputToolbar>
      </PromptInput>
    </>
  )
}

/**
 * The prompt input as it looks before the database opens (and on the
 * server): the same box, read-only, with a skeleton for the picked model,
 * which is a saved setting.
 */
export function PromptInputSkeleton() {
  const noop = () => undefined
  return (
    <PromptInput label="Message input" name="message">
      <PromptInputTextarea placeholder="Send a message..." value="" readOnly />
      <PromptInputToolbar>
        <PromptInputTools>
          {/* The size of the model picker's button. */}
          <Skeleton className="h-9 w-40 rounded-full md:h-8" />
        </PromptInputTools>
        <PromptInputTools end>
          <PromptInputSubmit
            status="ready"
            isDisabled
            onSubmit={noop}
            onStop={noop}
          />
        </PromptInputTools>
      </PromptInputToolbar>
    </PromptInput>
  )
}

/**
 * The model picker. A local model downloads when the first message is sent
 * to it; Apple's model is checked when picked, and setup steps show if it
 * can't be reached.
 */
function ChatModelSelector() {
  const model = useSelectedModel()
  const effort = useEffort()
  const models = useModels()
  const backends = useBackends()
  const afm = afmStatus.use()
  // The levels the picked model has, and the one it runs at.
  const efforts = effortOptions(model)
  const level = effortFor(model, effort)
  // Models by provider, each a section; a provider this device offers no
  // model of is left out.
  const sections = [...PROVIDERS]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .map((provider) => ({
      ...provider,
      detail: backends[provider.id],
      models: models
        .filter((m) => m.adapter.name === provider.id)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    }))
    .filter((section) => section.models.length > 0)
  // Counts picks, so a slow Apple check can't undo a newer choice.
  const lastPick = useRef(0)
  // The Apple model while its check runs, so the checkmark moves right away.
  const [pending, setPending] = useState<ModelId | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)

  const select = async (key: ModelId) => {
    const pick = ++lastPick.current
    if (key === "apple-fm") {
      // Only switch once apfel confirms Apple's model is there.
      afmStatus.set("checking")
      setPending(key)
      const isAvailable = await checkAfm()
      // A newer pick happened meanwhile; it owns the status now.
      if (pick !== lastPick.current) return
      setPending(null)
      afmStatus.set(isAvailable ? "idle" : "unavailable")
      setSetupOpen(!isAvailable)
      if (isAvailable) setSelectedModel(key)
      return
    }
    setPending(null)
    afmStatus.set("idle")
    setSelectedModel(key)
  }

  return (
    <>
      <AppleSetupModal
        isOpen={setupOpen}
        onOpenChange={setSetupOpen}
        onRetry={() => void select("apple-fm")}
        isChecking={afm === "checking"}
      />
      <ModelSelector
        sections={sections}
        value={pending ?? model}
        onChange={(id) => void select(id as ModelId)}
        efforts={efforts}
        effort={level}
        effortLabel={level && effortButtonLabel(model, level)}
        onEffortChange={(id) => setEffort(id as ReasoningLevel)}
      />
    </>
  )
}
