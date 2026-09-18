// Node ESM resolve hook so plain `node` can load lesionReport.js / volumeAnalysis.js
// unmodified. These are CRA app modules: lesionReport.js imports via the
// webpack "@/..." alias (see frontend/craco.config.js `alias: { '@': .../src }`),
// and retinotopyAnalysis.js uses extension-less relative imports ("./volumeAnalysis")
// which webpack resolves but plain Node ESM does not. This hook does both:
//   1. rewrites a leading "@/" to the frontend/src absolute path
//   2. if a resolution fails because the specifier has no extension, retries
//      with ".js" appended
// No production file is touched to make this work.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

export async function resolve(specifier, context, nextResolve) {
  let target = specifier;
  if (target.startsWith("@/")) {
    target = pathToFileURL(path.join(SRC_ROOT, target.slice(2))).href;
  }
  try {
    return await nextResolve(target, context);
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "ERR_UNSUPPORTED_DIR_IMPORT") {
      return await nextResolve(target + ".js", context);
    }
    throw err;
  }
}
