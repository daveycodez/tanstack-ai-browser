import { createFileRoute } from "@tanstack/react-router"
import { BenchmarkView } from "../components/benchmark"
import stylesheet from "../../bench/style.css?url"

export const Route = createFileRoute("/bench")({
  head: () => ({
    meta: [{ title: "Mancala · AI practice board" }],
    links: [{ rel: "stylesheet", href: stylesheet }]
  }),
  component: BenchmarkView
})
