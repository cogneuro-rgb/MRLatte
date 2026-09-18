import { useCallback, useRef, useState } from "react";

/**
 * Drag-to-reorder for a list of ids, on native HTML5 drag events.
 *
 * No new dependency: the project carries no DnD library (the only other drag
 * code is FileUploader's drop target), and one reorderable sidebar list does
 * not justify pulling in dnd-kit.
 *
 * Keyboard reordering is not an afterthought here — `moveBy` is the same code
 * path the pointer uses, so a keyboard user gets identical behaviour rather
 * than a second implementation that drifts.
 *
 *   const dnd = useDragReorder(ids, onReorder);
 *   <div {...dnd.itemProps(id)} data-dragging={dnd.draggingId === id}>
 *
 * @param {string[]} ids     current order
 * @param {(next: string[]) => void} onReorder  called with the new order
 */
export function useDragReorder(ids, onReorder) {
  const [draggingId, setDraggingId] = useState(null);
  const [overId, setOverId] = useState(null);
  // The live order during a drag. State would re-render on every dragover,
  // which fires continuously while the pointer moves.
  const orderRef = useRef(ids);
  orderRef.current = ids;

  const move = useCallback((fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return;
    const list = [...orderRef.current];
    const from = list.indexOf(fromId);
    const to = list.indexOf(toId);
    if (from < 0 || to < 0) return;
    list.splice(to, 0, list.splice(from, 1)[0]);
    onReorder(list);
  }, [onReorder]);

  /** Shift one item by `delta` places. Used by the keyboard handler. */
  const moveBy = useCallback((id, delta) => {
    const list = [...orderRef.current];
    const from = list.indexOf(id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(list.length - 1, from + delta));
    if (to === from) return;
    list.splice(to, 0, list.splice(from, 1)[0]);
    onReorder(list);
  }, [onReorder]);

  const itemProps = useCallback((id) => ({
    draggable: true,
    onDragStart: (e) => {
      setDraggingId(id);
      e.dataTransfer.effectAllowed = "move";
      // Firefox ignores a drag that sets no data.
      try { e.dataTransfer.setData("text/plain", id); } catch (_e) { /* older browsers */ }
    },
    onDragEnter: (e) => {
      e.preventDefault();
      setOverId(id);
    },
    onDragOver: (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDrop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      move(draggingId, id);
      setDraggingId(null);
      setOverId(null);
    },
    onDragEnd: () => {
      setDraggingId(null);
      setOverId(null);
    },
    onKeyDown: (e) => {
      // Alt+Arrow, so plain arrows still scroll the sidebar.
      if (!e.altKey) return;
      if (e.key === "ArrowUp") { e.preventDefault(); moveBy(id, -1); }
      if (e.key === "ArrowDown") { e.preventDefault(); moveBy(id, +1); }
    },
  }), [draggingId, move, moveBy]);

  return { draggingId, overId, itemProps, moveBy };
}

export default useDragReorder;
