/// <reference types="vite/client" />

// Vite's ambient types, which the project had not needed until something
// referenced `import.meta.env`. Without this, `import.meta.env.PROD` is a
// type error under `tsc -b` even though the bundler resolves it fine — so the
// build and the typecheck would disagree about whether the code is valid.
