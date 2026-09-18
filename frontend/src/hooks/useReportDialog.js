import { useState } from "react";

/**
 * Manages open/closed state for a ReportDialog. Avoids the repeated
 * `const [reportOpen, setReportOpen] = useState(false)` boilerplate in every
 * report-generating panel.
 *
 * Usage:
 *   const { reportOpen, setReportOpen, openReport } = useReportDialog();
 *   // trigger:  openReport()
 *   // render:   <ReportDialog open={reportOpen} onOpenChange={setReportOpen} html={html} />
 */
export function useReportDialog() {
  const [reportOpen, setReportOpen] = useState(false);
  const openReport = () => setReportOpen(true);
  return { reportOpen, setReportOpen, openReport };
}
