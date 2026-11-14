/** The files electron/afm.node is built from, in a fixed order. */
export function sourceFiles(): Array<string>
/** A SHA-256 of the sources: each file's path (from the package) and contents. */
export function sourcesHash(): string
/** Where the hash of the sources the committed addon was built from is kept. */
export const hashFile: string
