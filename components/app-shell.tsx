"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, History, ChartNoAxesCombined, Settings2 } from "lucide-react";
import { StaffLink } from "@/features/reviews/staff-link";

const links = [
  { href: "/interview-practice", label: "Practice", icon: BookOpen },
  { href: "/history", label: "History", icon: History },
  { href: "/progress", label: "Progress", icon: ChartNoAxesCombined },
  { href: "/settings", label: "Settings", icon: Settings2 },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const workspace = /^\/interview-practice\/[^/]+$/.test(pathname) && !pathname.endsWith("/new");
  return <>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="site-header">
      <div className="nav-shell">
        <Link className="brand" href="/interview-practice" aria-label="Engineering Foundry home"><span className="brand-mark" aria-hidden="true">EF</span><span>Engineering <strong>Foundry</strong></span></Link>
        <nav aria-label="Main navigation">{links.map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={pathname.startsWith(href) ? "nav-link active" : "nav-link"} aria-current={pathname.startsWith(href) ? "page" : undefined}><Icon size={16} aria-hidden="true" />{label}</Link>)}<StaffLink pathname={pathname} /></nav>
        <span className="app-label">Interview Lab</span>
      </div>
    </header>
    <main id="main-content" className={workspace ? "workspace-main" : "page-main"} tabIndex={-1}>{children}</main>
    {!workspace && <footer className="site-footer"><span>Engineering Foundry</span><span>Original exercises · Private practice · Evidence-linked feedback</span></footer>}
  </>;
}
