"use client";

import { useSyncExternalStore } from "react";
const key = "foundry-practice-preferences";
const defaults = JSON.stringify({ role: "Backend engineer", targetMinutes: 45, fontSize: 14 });
function subscribe(callback: () => void) { window.addEventListener("storage", callback); window.addEventListener("foundry-preferences", callback); return () => { window.removeEventListener("storage", callback); window.removeEventListener("foundry-preferences", callback); }; }
function snapshot() { try { return localStorage.getItem(key) || defaults; } catch { return defaults; } }
export function usePreferences(): { role: string; targetMinutes: number; fontSize: number } { const value = useSyncExternalStore(subscribe, snapshot, () => defaults); try { return JSON.parse(value); } catch { return JSON.parse(defaults); } }
export function savePreferences(value: { role: string; targetMinutes: number; fontSize: number }) { localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new Event("foundry-preferences")); }
