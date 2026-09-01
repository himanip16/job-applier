'use client';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  showInput?: boolean;
  inputPlaceholder?: string;
  inputValue?: string;
  onInputChange?: (value: string) => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  showInput = false,
  inputPlaceholder = '',
  inputValue = '',
  onInputChange,
}: ConfirmDialogProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 0.5rem' }}>{title}</h2>
        <p className="sub" style={{ marginBottom: '1rem' }}>{message}</p>
        
        {showInput && (
          <label className="field" style={{ marginBottom: '1rem' }}>
            <span>{inputPlaceholder}</span>
            <textarea
              value={inputValue}
              onChange={(e) => onInputChange?.(e.target.value)}
              placeholder="(optional)"
              style={{ minHeight: '80px' }}
            />
          </label>
        )}
        
        <div className="row">
          <button className="primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
          <button onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}