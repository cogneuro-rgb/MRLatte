import { useState, useEffect } from "react";

/**
 * Checks whether a backend module is available by calling `checkFn` once on
 * mount. Returns null while loading, true if available, or the raw response
 * object if the module responded but `ok` was falsy (used to show error details).
 *
 * @param {() => Promise<{ ok: boolean } | false>} checkFn
 * @returns {null | true | object | false}
 */
export function useModuleAvailable(checkFn) {
  const [available, setAvailable] = useState(null);
  useEffect(() => {
    checkFn().then((info) => setAvailable(info?.ok ? true : (info || false)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return available;
}
