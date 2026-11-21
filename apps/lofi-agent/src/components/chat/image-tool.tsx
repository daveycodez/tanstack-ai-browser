/**
 * The built-in image tool's widget (lib/image.ts): the drawn images in a
 * row, in place of the usual tool row, scaled up with their pixels kept
 * sharp. A line while it draws (with the model's download, the first
 * time), and a short line if it fails or stops.
 */
import { Spinner, Typography } from "@heroui/react"
import type { ToolProps } from "@tanstack/ai-react/ui"
import { useContext } from "react"

import type { chatOptions } from "#/chat/options"
import { imageDownload, imagesOf, pickedImageModel } from "#/lib/image"
import { errorOf, statusOf } from "./mcp-tool"
import { ReplyContext } from "./thread-context"

export function ImageTool({ part, result }: ToolProps<typeof chatOptions>) {
  const { isRunning } = useContext(ReplyContext)
  const download = imageDownload.use()
  const model = pickedImageModel()
  const input = (part.input ?? {}) as { prompt?: unknown }
  const prompt = typeof input.prompt === "string" ? input.prompt : undefined
  const images = imagesOf(part.output ?? result?.content)
  if (images.length > 0) {
    return (
      <div role="group" aria-label={prompt ? `Images of ${prompt}` : "Images"} className="flex flex-wrap gap-2">
        {images.map((src, i) => (
          <img
            key={i}
            src={src}
            alt={prompt ?? "Generated image"}
            width={16}
            height={16}
            className="size-32 rounded-md bg-surface-secondary [image-rendering:pixelated]"
          />
        ))}
      </div>
    )
  }

  const status = statusOf(part, result, isRunning)
  if (status === "error") {
    return (
      <Typography type="body-xs" className="text-danger">
        Couldn&apos;t draw{prompt ? ` ${prompt}` : " the images"}. {errorOf(part, result)}
      </Typography>
    )
  }
  if (status === "stopped") {
    return (
      <Typography type="body-xs" color="muted">
        Drawing stopped.
      </Typography>
    )
  }
  return (
    <Typography type="body-xs" color="muted" className="flex items-center gap-2">
      <Spinner size="sm" color="current" />
      {download !== undefined
        ? `Downloading ${model?.name ?? "the image model"}… ${Math.round(download * 100)}%`
        : prompt
          ? `Drawing ${prompt}…`
          : "Drawing…"}
    </Typography>
  )
}
