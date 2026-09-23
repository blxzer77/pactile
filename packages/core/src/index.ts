// Root barrel — re-exports the task and Pactile contract APIs so callers
// can `import { ... } from "@blxzer/pactile-core"`. Sub-path
// imports (`@blxzer/pactile-core/task`) remain the
// recommended form for tree-shake-friendly consumption.

export * from "./task/index.js";
export * from "./pactile/index.js";
export * from "./compat/index.js";
