/**
 * Wraps a single-file handler into a serial multi-file handler.
 * Usage: onFiles={serialUpload((f) => addUserFile(f, "lesion"))}
 */
export const serialUpload = (fn) => async (files) => {
  for (const f of files) await fn(f);
};
