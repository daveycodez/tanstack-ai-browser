import { createFileRoute } from "@tanstack/react-router"
import { BenchmarkView } from "../components/benchmark"
import stylesheet from "../../bench/style.css?url"

export const Route = createFileRoute("/bench")({
  head: () => ({
    meta: [{ title: "Chess AI · Manual benchmark" }],
    links: [{ rel: "stylesheet", href: stylesheet }]
  }),
  component: BenchmarkView
})
