import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ModalBackdropProps {
  children: ReactNode;
  label: string;
  onClose?: () => void;
  className?: string;
}

export function ModalBackdrop({ children, label, onClose, className }: ModalBackdropProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return createPortal(
    <dialog
      ref={ref}
      className={["modal-backdrop", "loors-dialog", className].filter(Boolean).join(" ")}
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) onClose?.();
      }}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose?.();
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      {children}
    </dialog>,
    document.body
  );
}
