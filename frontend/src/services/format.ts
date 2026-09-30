export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (!Number.isFinite(value)) return '∞';
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const fixed = Number(value.toPrecision(12));
  return String(fixed);
}
