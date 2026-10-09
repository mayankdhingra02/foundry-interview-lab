"use client";

import { useRef } from 'react';

export class ReviewError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function reviewRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ReviewError(result.error?.message || 'The review request could not finish. Your saved practice work is available.', response.status);
  return result as T;
}
export function useReviewKeys() {
  const keys = useRef(new Map<string, { payload: string; key: string }>());
  const issue = (operation: string, payload: object) => {
    const fingerprint = JSON.stringify(payload); const previous = keys.current.get(operation);
    if (previous?.payload === fingerprint) return previous.key;
    const key = crypto.randomUUID(); keys.current.set(operation, { payload: fingerprint, key }); return key;
  };
  issue.complete = (operation: string) => keys.current.delete(operation);
  return issue;
}
