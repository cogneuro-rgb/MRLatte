// Entry point for `node --import`. Registers alias-hook.mjs as a module
// resolution hook *before* run.mjs's own static imports are resolved
// (module.register must run before the graph it affects is loaded).
import { register } from "node:module";

register("./alias-hook.mjs", import.meta.url);
