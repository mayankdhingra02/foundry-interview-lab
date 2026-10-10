"use client";

import { AlertCircle, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef } from "react";

export function Loading({ children = "Loading…" }: { children?: React.ReactNode }) { return <div className="loading" role="status"><LoaderCircle size={18} className="spinner" aria-hidden="true" />{children}</div>; }
export function ErrorNotice({ message, action }: { message: string; action?: React.ReactNode }) { return <div className="notice error" role="alert"><AlertCircle size={18} aria-hidden="true" /><div>{message}{action && <div className="notice-action">{action}</div>}</div></div>; }
export function Empty({ title, children }: { title: string; children: React.ReactNode }) { return <div className="empty"><h2>{title}</h2><div>{children}</div></div>; }
export function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="dialog" aria-label={title} onCancel={onClose}><div className="dialog-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>{children}</dialog>;
}
