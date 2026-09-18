import React from "react";

/**
 * Drop-in replacement for `React.lazy` that retries the dynamic import once
 * after `delayMs` if the first attempt fails (e.g. a stale chunk URL after an
 * HMR rebuild). If the retry also fails, the error propagates normally and is
 * caught by the nearest error boundary.
 *
 * Usage:
 *   const MyPanel = lazyWithRetry(() => import("@/components/MyPanel"));
 *
 * @param {() => Promise<{ default: React.ComponentType }>} factory
 * @param {number} [delayMs=500]
 */
export function lazyWithRetry(factory, delayMs = 500) {
  return React.lazy(() =>
    factory().catch(
      () =>
        new Promise((resolve) => setTimeout(resolve, delayMs)).then(factory)
    )
  );
}
