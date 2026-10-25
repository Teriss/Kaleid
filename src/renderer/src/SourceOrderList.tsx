import { useState } from "react";
import { GripVertical } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";

interface SourceOrderItem {
  id: string;
  name: string;
  enabled: boolean;
}

export default function SourceOrderList<T extends SourceOrderItem>({
  items,
  idPrefix,
  disabled = false,
  emptyText,
  onToggle,
  onReorder,
}: {
  items: T[];
  idPrefix: string;
  disabled?: boolean;
  emptyText: string;
  onToggle(source: T, enabled: boolean): void;
  onReorder(draggedId: string, targetId: string, insertAfter: boolean): void;
}) {
  const [draggingId, setDraggingId] = useState<string>();
  const reduceMotion = useReducedMotion();

  return (
    <div
      className="comic-source-quick-list"
      onDragOver={(event) => {
        if (!draggingId) return;
        event.preventDefault();
        const list = event.currentTarget;
        const bounds = list.getBoundingClientRect();
        const edge = Math.min(52, bounds.height * 0.28);
        const topDistance = event.clientY - bounds.top;
        const bottomDistance = bounds.bottom - event.clientY;
        if (topDistance >= 0 && topDistance < edge) {
          const speed = Math.max(3, Math.ceil(((edge - topDistance) / edge) * 12));
          list.scrollTop -= speed;
        } else if (bottomDistance >= 0 && bottomDistance < edge) {
          const speed = Math.max(
            3,
            Math.ceil(((edge - bottomDistance) / edge) * 12),
          );
          list.scrollTop += speed;
        }
      }}
    >
      {items.map((source) => (
        <motion.div
          layout="position"
          transition={{
            layout: { duration: reduceMotion ? 0 : 0.16, ease: "easeOut" },
          }}
          className={`comic-source-quick-row${draggingId === source.id ? " is-dragging" : ""}`}
          key={source.id}
          onDragOver={(event) => {
            if (!draggingId) return;
            event.preventDefault();
            if (draggingId === source.id) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            onReorder(
              draggingId,
              source.id,
              event.clientY >= bounds.top + bounds.height / 2,
            );
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDraggingId(undefined);
          }}
        >
          <input
            id={`${idPrefix}-source-enabled-${source.id}`}
            type="checkbox"
            checked={source.enabled}
            disabled={disabled}
            onChange={(event) => onToggle(source, event.target.checked)}
          />
          <label htmlFor={`${idPrefix}-source-enabled-${source.id}`}>
            <span>{source.name}</span>
            <small>{source.enabled ? "已激活" : "未激活"}</small>
          </label>
          <button
            type="button"
            className="comic-source-drag-handle"
            draggable={!disabled}
            aria-label={`拖动以调整 ${source.name} 的排序`}
            title="拖动排序"
            onDragStart={(event) => {
              const dragImage = document.createElement("canvas");
              dragImage.width = 1;
              dragImage.height = 1;
              event.dataTransfer.setDragImage(dragImage, 0, 0);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", source.id);
              setDraggingId(source.id);
            }}
            onDragEnd={() => setDraggingId(undefined)}
          >
            <GripVertical size={17} />
          </button>
        </motion.div>
      ))}
      {!items.length && <p className="muted">{emptyText}</p>}
    </div>
  );
}
