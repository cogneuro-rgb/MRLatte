import * as React from "react"
import { createPortal } from "react-dom"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"

// A right-click menu at the pointer (inbox 28 Oct). `menu` is { x, y, items }
// or null; an item is { label, onSelect, checked?, disabled?, danger?, hint? }
// or "-" for a separator. Every item repeats an action that already has a
// button, shortcut or app-menu entry: the menu is one more way there, never
// the only one. Arrow keys / Home / End move, Enter or Space picks; Esc, Tab,
// a click elsewhere, scrolling, resizing or leaving the window closes it, and
// focus goes back to where it was.
export function ContextMenu({ menu, onClose, label = "Actions" }) {
  const ref = React.useRef(null)
  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose

  // Kept inside the window, placed before the first paint, then the first item
  // takes the focus (a still-hidden element can't). Each menu is a fresh
  // element: null in between unmounts it.
  React.useLayoutEffect(() => {
    if (!menu) return undefined
    const returnTo = document.activeElement
    const el = ref.current
    el.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - el.offsetWidth - 4))}px`
    el.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - el.offsetHeight - 4))}px`
    el.style.visibility = "visible"
    el.querySelector('[role^="menuitem"]:not(:disabled)')?.focus()
    return () => returnTo?.focus?.()
  }, [menu])

  React.useEffect(() => {
    if (!menu) return undefined
    const close = () => onCloseRef.current()
    const onDown = (e) => { if (!ref.current?.contains(e.target)) close() }
    window.addEventListener("pointerdown", onDown, true)
    window.addEventListener("wheel", close, true)
    window.addEventListener("resize", close)
    window.addEventListener("blur", close)
    return () => {
      window.removeEventListener("pointerdown", onDown, true)
      window.removeEventListener("wheel", close, true)
      window.removeEventListener("resize", close)
      window.removeEventListener("blur", close)
    }
  }, [menu])

  if (!menu) return null

  // Handled keys stop here, so the viewer's own shortcuts (↑/↓ step slices)
  // don't also act while the menu is open.
  const onKeyDown = (e) => {
    const items = [...ref.current.querySelectorAll('[role^="menuitem"]:not(:disabled)')]
    const i = items.indexOf(document.activeElement)
    const go = (j) => { e.preventDefault(); e.stopPropagation(); items[(j + items.length) % items.length]?.focus() }
    if (e.key === "ArrowDown") go(i + 1)
    else if (e.key === "ArrowUp") go(i - 1)
    else if (e.key === "Home") go(0)
    else if (e.key === "End") go(items.length - 1)
    else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); onClose() }
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="popover fixed z-[100] min-w-[210px] p-1"
      style={{ left: menu.x, top: menu.y, visibility: "hidden" }}
      data-testid="context-menu"
    >
      {menu.items.map((item, i) => item === "-" ? (
        <div key={i} role="separator" className="mx-1 my-1 h-px bg-border" />
      ) : (
        <button
          key={i}
          type="button"
          role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
          aria-checked={item.checked === undefined ? undefined : !!item.checked}
          tabIndex={-1}
          disabled={item.disabled}
          onClick={() => { onClose(); item.onSelect() }}
          className={cn(
            "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] outline-none transition-colors",
            "hover:bg-panel-hover focus:bg-panel-hover disabled:opacity-40",
            item.danger ? "text-destructive" : "text-foreground",
          )}
        >
          <span className="grid w-3.5 flex-shrink-0 place-items-center">{item.checked && <Check size={12} />}</span>
          <span className="flex-1 truncate">{item.label}</span>
          {item.hint && <span className="pl-4 font-mono text-[11.5px] text-subtle">{item.hint}</span>}
        </button>
      ))}
    </div>,
    document.body,
  )
}

// Opening a menu from an onContextMenu handler: `open(e, items)`.
export function useContextMenu() {
  const [menu, setMenu] = React.useState(null)
  const open = React.useCallback((e, items) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }, [])
  const close = React.useCallback(() => setMenu(null), [])
  return { menu, open, close }
}
