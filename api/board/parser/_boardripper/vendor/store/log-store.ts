// Wrench Board adapter: the upstream UI logger is intentionally not imported.
// Diagnostics stay on stderr; stdout is reserved for the JSON response.
const silent = (..._args: unknown[]) => {};
export const log = { parser: { log: silent, warn: silent, error: silent, debug: silent, info: silent } };
