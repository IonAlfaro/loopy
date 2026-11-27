import { useRef } from "react";

interface PanelResizerProps {
  label: string;
  side: "left" | "right";
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
  storageKey: string;
  onResize: (width: number) => void;
}

export function PanelResizer({
  label, side, width, min, max, defaultWidth, storageKey, onResize,
}: PanelResizerProps) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const direction = side === "left" ? 1 : -1;
  const resize = (value: number) => {
    const next = Math.max(min, Math.min(max, value));
    onResize(next);
    localStorage.setItem(storageKey, String(next));
  };

  return (
    <div
      className="panel-resizer"
      role="separator"
      tabIndex={0}
      title={label}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 10;
        const next = {
          ArrowLeft: width - direction * step,
          ArrowRight: width + direction * step,
          Home: min,
          End: max,
        }[event.key];
        if (typeof next !== "number") return;
        event.preventDefault();
        resize(next);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        resize(drag.current.width + direction * (event.clientX - drag.current.x));
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onDoubleClick={() => resize(defaultWidth)}
    />
  );
}
