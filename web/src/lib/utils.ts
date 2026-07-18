import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { TS } from '@asm/shared';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function tsToDate(ts: TS | null | undefined): Date | null {
  if (!ts || typeof ts.toMillis !== 'function') return null;
  return new Date(ts.toMillis());
}

export function timeAgo(ts: TS | Date | null | undefined): string {
  const date = ts instanceof Date ? ts : tsToDate(ts ?? null);
  if (!date) return '—';
  const secs = Math.round((Date.now() - date.getTime()) / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}
