export type BillingInterval = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

export function addBillingInterval(date: Date, interval: BillingInterval, count: number): Date {
  const maxCount = interval === 'DAY' ? 365 : 12;
  if (!Number.isInteger(count) || count < 1 || count > maxCount || !Number.isFinite(date.getTime())) {
    throw new RangeError('Invalid billing interval');
  }
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  let targetYear = year;
  let targetMonth = month;
  let targetDay = day;
  if (interval === 'DAY') targetDay += count;
  if (interval === 'WEEK') targetDay += count * 7;
  if (interval === 'MONTH') {
    const absoluteMonth = year * 12 + month + count;
    targetYear = Math.floor(absoluteMonth / 12);
    targetMonth = absoluteMonth % 12;
    targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  }
  if (interval === 'YEAR') {
    targetYear += count;
    targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  }
  return new Date(Date.UTC(
    targetYear, targetMonth, targetDay, date.getUTCHours(), date.getUTCMinutes(),
    date.getUTCSeconds(), date.getUTCMilliseconds(),
  ));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}
