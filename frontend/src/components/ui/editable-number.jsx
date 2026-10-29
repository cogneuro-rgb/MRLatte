import * as React from "react"

import { cn } from "@/lib/utils"

// A slider's value readout that can be typed into: double-click it, type, then
// Enter (or click away) applies and Esc cancels. The typed number is clamped to
// the slider's [min, max], and rounded when the slider only takes whole
// numbers. `value` and `onCommit` use the slider's own scale (opacity 0–100,
// not 0–1), so a caller passes exactly what its slider's onValueChange does.
// `children` is the usual readout, shown unchanged while not editing.
const EditableNumber = ({ value, min, max, integer = false, onCommit, label, className, children, ...props }) => {
  const [draft, setDraft] = React.useState(null)
  // Enter / Esc finish the edit themselves, and the blur that follows (or a
  // click away) must not apply it a second time.
  const editing = React.useRef(false)

  const start = () => {
    editing.current = true
    setDraft(String(Number(Number(value).toFixed(integer ? 0 : 4))))
  }
  const finish = (apply) => {
    if (!editing.current) return
    editing.current = false
    const v = parseFloat(String(draft).replace(",", "."))
    setDraft(null)
    if (!apply || !Number.isFinite(v)) return
    const clamped = Math.min(max, Math.max(min, integer ? Math.round(v) : v))
    if (clamped !== value) onCommit(clamped)
  }

  if (draft !== null) {
    return (
      <input
        autoFocus
        inputMode="decimal"
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(true)
          else if (e.key === "Escape") { e.stopPropagation(); finish(false) }
        }}
        className={cn(className, "field h-6 min-h-0 min-w-[3.25rem] px-1 text-right font-mono text-[11.5px]")}
        {...props}
      />
    )
  }
  return (
    <span
      onDoubleClick={start}
      title={`${label}: double-click to type a value`}
      className={cn("cursor-text", className)}
      {...props}
    >
      {children}
    </span>
  )
}

export { EditableNumber }
