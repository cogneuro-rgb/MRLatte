/**
 * Shared filename utilities — previously duplicated verbatim in
 * TractDissectionPanel.jsx and DaLnMapperPanel.jsx.
 */
export const MAX_DEFAULT_NAME_LEN = 40;

/** Strip .nii or .nii.gz extension from a filename string. */
export const stripNiftiExt = (name) => (name || "").replace(/\.nii(\.gz)?$/i, "");

/** Truncate a string to n chars, appending … if it was longer. */
export const truncateName = (s, n = MAX_DEFAULT_NAME_LEN) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;
