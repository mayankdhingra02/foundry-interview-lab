"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ClipboardCheck } from 'lucide-react';

export function StaffLink({ pathname }: { pathname: string }) {
  const [allowedPath, setAllowedPath] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const check = () => fetch('/api/internal/access', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal }).then(async response => response.ok && (await response.json()).allowed === true)
      .then(allowed => { if (!controller.signal.aborted) setAllowedPath(allowed ? pathname : null); }).catch(() => { if (!controller.signal.aborted) setAllowedPath(null); });
    void check();
    const onFocus = () => { void check(); }; window.addEventListener('focus', onFocus);
    const timer = window.setInterval(onFocus, 30_000);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [pathname]);
  if (allowedPath !== pathname) return null;
  return <Link href="/internal" className={pathname.startsWith('/internal') ? 'nav-link active' : 'nav-link'} aria-current={pathname.startsWith('/internal') ? 'page' : undefined}><ClipboardCheck size={16} aria-hidden="true" />Staff review</Link>;
}
