import React from "react";
import { lqtpyReleaseUrl } from "@/lib/lesionMetrics";

/**
 * "lqtpy 0.7.0" as a link to that release (inbox 29 Oct). `version` is what
 * the running engine reported, so the credit follows the installed lqtpy;
 * nothing renders without one (an older backend, or lqtpy missing).
 */
export function LqtpyCredit({ version, prefix }) {
  if (!version) return null;
  return (
    <span className="text-[11.5px] text-subtle" data-testid="lqtpy-credit">
      {prefix}
      <a
        href={lqtpyReleaseUrl(version)}
        target="_blank"
        rel="noreferrer"
        className="font-mono hover:text-foreground hover:underline"
        title="Open this lqtpy release on GitHub"
      >
        lqtpy {version}
      </a>
    </span>
  );
}

export default LqtpyCredit;
