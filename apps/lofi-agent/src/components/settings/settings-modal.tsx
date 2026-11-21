/**
 * The Settings modal: the system prompt for every model (the default, or the
 * user's own, with a button to put the default back), the built-in
 * weather and location tools, the image tool's model, and deleting every
 * session.
 */
import TrashBin from "@gravity-ui/icons/TrashBin"
import {
  AlertDialog,
  Button,
  Description,
  Header,
  Label,
  ListBox,
  Modal,
  Select,
  Switch,
  TextArea,
  TextField
} from "@heroui/react"
import { useLiveQuery, useOptionalDbClient } from "@tanstack/react-db"
import { useState } from "react"

import { threadsCollection } from "#/lib/db"
import { DEFAULT_SYSTEM_PROMPT, systemPromptSetting } from "#/lib/settings"
import { locationToolSetting } from "#/lib/location"
import { timeToolsSetting } from "#/lib/time"
import { weatherToolSetting } from "#/lib/weather"
import { IMAGE_MODELS, imageModelEntry, imageModelSetting, NO_IMAGE_MODEL } from "#/lib/image"
import type { ImageModelChoice } from "#/lib/image"
import { deleteAllThreads } from "#/lib/threads"

export function SettingsModal({
  isOpen,
  onOpenChange,
  onAllDeleted
}: {
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
  /** Called once every session is deleted (the app opens a new one). */
  onAllDeleted: () => void
}) {
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          {({ close }) => (
            <SettingsForm
              onDone={close}
              onAllDeleted={() => {
                close()
                onAllDeleted()
              }}
            />
          )}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

/**
 * Edits a copy of the settings: Save keeps the changes, Cancel (or closing
 * the modal) drops them. Mounted each time the modal opens, so it starts
 * from the saved values.
 */
function SettingsForm({
  onDone,
  onAllDeleted
}: {
  onDone: () => void
  onAllDeleted: () => void
}) {
  const [systemPrompt, setSystemPrompt] = useState(systemPromptSetting.get)
  const [timeTools, setTimeTools] = useState(timeToolsSetting.get)
  const [locationTool, setLocationTool] = useState(locationToolSetting.get)
  const [weatherTool, setWeatherTool] = useState(weatherToolSetting.get)
  const [imageModel, setImageModel] = useState(imageModelSetting.get)
  const picked = imageModelEntry(imageModel)
  return (
    <>
      <Modal.CloseTrigger />
      <Modal.Header>
        <Modal.Heading>Settings</Modal.Heading>
      </Modal.Header>
      <Modal.Body className="flex flex-col gap-6">
        <TextField
          variant="secondary"
          value={systemPrompt}
          onChange={setSystemPrompt}
        >
          <Label>System prompt</Label>
          <TextArea
            rows={6}
            placeholder="For example: Answer briefly, in plain English."
            className="resize-y"
          />
          <Description>
            Sent to every model at the start of each session. Kept in this
            browser only.
          </Description>
        </TextField>
        {/* The default prompt back in the field: saved with the rest. */}
        <Button
          size="sm"
          variant="tertiary"
          isDisabled={systemPrompt === DEFAULT_SYSTEM_PROMPT}
          onPress={() => setSystemPrompt(DEFAULT_SYSTEM_PROMPT)}
          className="-mt-4 self-start"
        >
          Reset to default
        </Button>
        <Switch isSelected={timeTools} onChange={setTimeTools}>
          <Switch.Content className="w-full justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Label>Current time</Label>
              <Description>
                Lets models read the current date and time, here or in another
                time zone. Works offline.
              </Description>
            </div>
            <Switch.Control className="shrink-0">
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
        <Switch isSelected={locationTool} onChange={setLocationTool}>
          <Switch.Content className="w-full justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Label>Location</Label>
              <Description>
                Lets models ask for your current location, to the nearest
                kilometer. Your browser asks you before sharing it.
              </Description>
            </div>
            <Switch.Control className="shrink-0">
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
        <Switch isSelected={weatherTool} onChange={setWeatherTool}>
          <Switch.Content className="w-full justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Label>Weather</Label>
              <Description>
                Lets models look up the weather. The city asked about is sent
                to <span className="whitespace-nowrap">Open-Meteo</span>.
              </Description>
            </div>
            <Switch.Control className="shrink-0">
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
        <Select
          variant="secondary"
          value={imageModel}
          onChange={(value) => {
            if (typeof value === "string") setImageModel(value as ImageModelChoice)
          }}
        >
          <Label>Image model</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Description>
            Lets models draw pixel-art images, on this device.{" "}
            {picked &&
              `${picked.name} on ${picked.provider}. Downloads ${picked.download} the first time. ${picked.license}: not for commercial use.`}
          </Description>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id={NO_IMAGE_MODEL} textValue="None">
                None
                <ListBox.ItemIndicator />
              </ListBox.Item>
              {[...new Set(IMAGE_MODELS.map((model) => model.provider))].map((provider) => (
                <ListBox.Section key={provider}>
                  <Header>{provider}</Header>
                  {IMAGE_MODELS.filter((model) => model.provider === provider).map((model) => (
                    <ListBox.Item key={model.id} id={model.id} textValue={`${model.name} (${model.provider})`}>
                      {model.name}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox.Section>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <DeleteAllSessions onDeleted={onAllDeleted} />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="tertiary" onPress={onDone}>
          Cancel
        </Button>
        <Button
          onPress={() => {
            systemPromptSetting.set(systemPrompt)
            timeToolsSetting.set(timeTools)
            locationToolSetting.set(locationTool)
            weatherToolSetting.set(weatherTool)
            imageModelSetting.set(imageModel)
            onDone()
          }}
        >
          Save
        </Button>
      </Modal.Footer>
    </>
  )
}

/**
 * Deletes every session, archived ones included, once confirmed. Takes
 * effect right away, apart from the form's Save.
 */
function DeleteAllSessions({ onDeleted }: { onDeleted: () => void }) {
  const db = useOptionalDbClient()
  const { data: threads } = useLiveQuery({
    query: (q) => (db ? q.from({ thread: threadsCollection }) : null)
  })
  const count = threads?.length ?? 0
  const [isConfirming, setIsConfirming] = useState(false)
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium">Delete all sessions</p>
        <p className="text-xs text-muted">
          Permanently deletes every session, archived ones included.
        </p>
      </div>
      <Button
        size="sm"
        variant="danger-soft"
        isDisabled={count === 0}
        onPress={() => setIsConfirming(true)}
        className="shrink-0"
      >
        Delete all
      </Button>

      <AlertDialog.Backdrop
        isOpen={isConfirming}
        onOpenChange={setIsConfirming}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[400px]">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger">
                <TrashBin className="size-5" />
              </AlertDialog.Icon>
              <AlertDialog.Heading>Delete all sessions?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>
                This permanently deletes{" "}
                {count === 1 ? "your session" : `all ${count} sessions`},
                including archived ones. This can&apos;t be undone.
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">
                Cancel
              </Button>
              <Button
                slot="close"
                variant="danger"
                onPress={() => {
                  deleteAllThreads()
                  onDeleted()
                }}
              >
                Delete All
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </div>
  )
}
