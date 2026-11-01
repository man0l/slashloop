// Counter parsing shared by the providers' fetchMetrics — platforms return
// counts as numbers or numeric strings (YouTube), and omit what they lack.

export function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}
