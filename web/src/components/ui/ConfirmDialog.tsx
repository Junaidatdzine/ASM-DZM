import { useEffect, useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from './Dialog';
import { Button } from './Button';
import { Input } from './Input';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  /** When set, the user must type this exact string to enable the confirm button. */
  typeToConfirm?: string;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive,
  typeToConfirm,
  loading,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);
  const blocked = !!typeToConfirm && typed !== typeToConfirm;

  return (
    <Dialog open={open} onOpenChange={loading ? () => {} : onOpenChange}>
      <DialogContent>
        <DialogHeader title={title} description={description} />
        {typeToConfirm && (
          <div className="space-y-1.5">
            <p className="text-[13px] text-muted-foreground">
              Type <span className="select-all rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{typeToConfirm}</span> to confirm.
            </p>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={typeToConfirm}
              autoFocus
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'primary'}
            disabled={blocked}
            loading={loading}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
