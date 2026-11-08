/**
 * The built-in weather tool's widget (lib/weather.ts): a HeroUI Card drawn
 * from its typed result, in place of the usual tool row.
 */
import Cloud from "@gravity-ui/icons/Cloud"
import Clouds from "@gravity-ui/icons/Clouds"
import Droplet from "@gravity-ui/icons/Droplet"
import Moon from "@gravity-ui/icons/Moon"
import Snowflake from "@gravity-ui/icons/Snowflake"
import Sun from "@gravity-ui/icons/Sun"
import Thunderbolt from "@gravity-ui/icons/Thunderbolt"
import Umbrella from "@gravity-ui/icons/Umbrella"
import { Card, Spinner, Typography } from "@heroui/react"
import type { ToolProps } from "@tanstack/ai-react/ui"
import { useContext, useId } from "react"
import type { SVGProps } from "react"

import type { chatOptions } from "#/chat/options"
import { asWeatherReport } from "#/lib/weather"
import type { WeatherCondition, WeatherReport } from "#/lib/weather"
import { errorOf, statusOf } from "./mcp-tool"
import { ReplyContext } from "./thread-context"

/** A condition's icon; a clear night is a moon. */
function WeatherIcon({
  condition,
  isDay = true,
  ...props
}: SVGProps<SVGSVGElement> & { condition: WeatherCondition; isDay?: boolean }) {
  switch (condition) {
    case "clear":
      return isDay ? <Sun {...props} /> : <Moon {...props} />
    case "partly-cloudy":
      return <Cloud {...props} />
    case "cloudy":
    case "fog":
      return <Clouds {...props} />
    case "drizzle":
      return <Droplet {...props} />
    case "rain":
      return <Umbrella {...props} />
    case "snow":
      return <Snowflake {...props} />
    case "thunderstorm":
      return <Thunderbolt {...props} />
  }
}

/** "Today", then short weekday names in the browser's language. */
function dayName(date: string, index: number) {
  if (index === 0) return "Today"
  // Noon, so no time zone moves the date to another day.
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short"
  })
}

/**
 * The whole tool call, in place of the usual tool row, as TanStack AI's
 * "Make a tool look right" recipe does: a line while it runs, the card once
 * the result is in, and a short line if it fails or stops.
 */
export function WeatherTool({ part, result }: ToolProps<typeof chatOptions>) {
  const { isRunning } = useContext(ReplyContext)
  const report = asWeatherReport(part.output ?? result?.content)
  if (report) return <WeatherCard report={report} />

  const input = (part.input ?? {}) as { city?: unknown }
  const city = typeof input.city === "string" ? input.city : undefined
  const status = statusOf(part, result, isRunning)
  if (status === "error") {
    return (
      <Typography type="body-xs" className="text-danger">
        Couldn&apos;t get the weather{city ? ` for ${city}` : ""}.{" "}
        {errorOf(part, result)}
      </Typography>
    )
  }
  if (status === "stopped") {
    return (
      <Typography type="body-xs" color="muted">
        Weather lookup stopped.
      </Typography>
    )
  }
  return (
    <Typography
      type="body-xs"
      color="muted"
      className="flex items-center gap-2"
    >
      <Spinner size="sm" color="current" />
      {city ? `Checking the weather in ${city}…` : "Looking up the weather…"}
    </Typography>
  )
}

function WeatherCard({ report }: { report: WeatherReport }) {
  const { current, days, unit, windUnit } = report
  const titleId = useId()
  return (
    <Card role="article" aria-labelledby={titleId}>
      <Card.Header className="flex-row items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <Card.Title id={titleId} className="truncate">
            {report.location}
          </Card.Title>
          <Typography
            type="h1"
            render={({ children, ...props }) => <p {...props}>{children}</p>}
            className="leading-none tabular-nums"
          >
            {current.temperature}
            <span className="align-top text-lg font-medium text-muted">
              {unit}
            </span>
          </Typography>
          <Card.Description className="tabular-nums">
            {current.summary} · Feels like {current.feelsLike}° · Humidity{" "}
            {current.humidity}% · Wind {current.wind} {windUnit}
          </Card.Description>
        </div>
        <WeatherIcon
          condition={current.condition}
          isDay={current.isDay}
          aria-hidden
          className="size-8 shrink-0 text-muted"
        />
      </Card.Header>
      <Card.Content>
        <ol className="grid grid-cols-5 gap-2 text-center">
          {days.map((day, i) => (
            <li
              key={day.date}
              className="flex flex-col items-center gap-1.5"
              title={day.summary}
            >
              <Typography type="body-xs" color="muted">
                {dayName(day.date, i)}
              </Typography>
              <WeatherIcon
                condition={day.condition}
                aria-label={day.summary}
                className="size-4 text-muted"
              />
              <Typography type="body-xs" className="tabular-nums">
                {day.high}° <span className="text-muted">{day.low}°</span>
              </Typography>
            </li>
          ))}
        </ol>
      </Card.Content>
    </Card>
  )
}
