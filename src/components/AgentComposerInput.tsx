import { useRef } from "react";

interface Props {
  value: string;
  placeholder: string;
  label: string;
  onChange: (value: string) => void;
  onFiles: (files: FileList) => void;
  onSend: () => void;
}

export function AgentComposerInput({ value, placeholder, label, onChange, onFiles, onSend }: Props) {
  const composing = useRef(false);
  return <textarea
    rows={2}
    aria-label={label}
    placeholder={placeholder}
    value={value}
    onChange={e => onChange(e.target.value)}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; }}
    onPaste={e => {
      if (e.clipboardData.files.length > 0) {
        e.preventDefault();
        onFiles(e.clipboardData.files);
      }
    }}
    onKeyDown={e => {
      if (e.key !== "Enter" || e.shiftKey || composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if (!e.repeat) onSend();
    }}
  />;
}
