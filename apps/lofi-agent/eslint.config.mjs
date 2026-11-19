import nx from "@nx/eslint-plugin"
import baseConfig from "../../eslint.config.mjs"

export default [
  ...baseConfig,
  ...nx.configs["flat/react"],
  // eslint-plugin-react detects the React version through an API ESLint 10
  // removed (context.getFilename), so the version is given here.
  { settings: { react: { version: "19.3" } } },
  // The Xcode and Android projects, with Capacitor's copies of the built site in them.
  { ignores: ["ios", "android"] }
]
