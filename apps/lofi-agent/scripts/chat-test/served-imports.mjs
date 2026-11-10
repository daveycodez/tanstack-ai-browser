/**
 * The imports a bundle kept (esbuild's metafile `imports` of one output)
 * that a page can't load from the test server: bare names and file paths
 * the browser can't resolve, and URLs outside the server's routes.
 *
 * @param {string} from The output's path on the server, such as "/browser.js".
 * @param {Array<{ path: string, external?: boolean }>} imports
 * @param {Array<string>} served The paths the server serves.
 * @returns {Array<string>} Each unserved import, with the output it's in.
 */
export function unservedImports(from, imports, served) {
  const origin = "http://chat-test.invalid"
  return imports
    .filter(({ path }) => {
      // A bare name, such as "react", needs an import map the page doesn't have.
      if (!/^(\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(path)) return true
      const url = new URL(path, origin + from)
      return url.origin !== origin || !served.includes(url.pathname)
    })
    .map(({ path }) => `${from} imports ${path}`)
}
