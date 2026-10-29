// The folder (or .zip) a set of DICOM files was picked from, via Electron's
// file paths; null in the browser build or when the files share no folder.
export function dicomSourceOf(files) {
  const paths = Array.from(files).map((f) => window.mrlatte?.getPathForFile?.(f)).filter(Boolean);
  if (!paths.length) return null;
  if (paths.length === 1 && /\.zip$/i.test(paths[0])) return { type: "zip", path: paths[0] };
  const parts = paths.map((p) => p.split(/[\\/]/).slice(0, -1));
  const common = [];
  for (let i = 0; i < parts[0].length; i++) {
    if (parts.every((q) => q[i] === parts[0][i])) common.push(parts[0][i]);
    else break;
  }
  if (!common.length) return null;
  const sep = paths[0].includes("\\") ? "\\" : "/";
  let folder = common.join(sep);
  if (/^[A-Za-z]:$/.test(folder)) folder += sep;          // a drive root
  if (paths[0].startsWith(sep + sep) && !folder.startsWith(sep + sep)) folder = sep + sep + folder.replace(/^[\\/]+/, "");
  return { type: "folder", path: folder };
}
