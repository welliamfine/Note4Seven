import { AppError } from '../lib/errors';
import { daysBetweenShanghai, shanghaiDate } from '../lib/time';

export const MIN_RECORD_DATE = '1900-01-01';
export const MAX_RECORD_DATE = '2099-12-31';

export type RecordPolicy = 'strict' | 'relaxed';

export function assertRecordDateInRange(recordDate: string): void {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(recordDate)
    ? new Date(`${recordDate}T00:00:00Z`)
    : null;
  if (!parsed
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== recordDate
    || recordDate < MIN_RECORD_DATE
    || recordDate > MAX_RECORD_DATE) {
    throw new AppError('RECORD_DATE_OUT_OF_RANGE', `记录日期必须在 ${MIN_RECORD_DATE} 至 ${MAX_RECORD_DATE} 之间`, 422, {
      minDate: MIN_RECORD_DATE,
      maxDate: MAX_RECORD_DATE,
    });
  }
}

export function assertNormalRecordDate(policy: RecordPolicy, recordDate: string, today = shanghaiDate()): void {
  assertRecordDateInRange(recordDate);
  if (policy === 'strict' && recordDate !== today) {
    throw new AppError('RECORD_DATE_NOT_ALLOWED', '严厉模式只能正常记录今天', 422, { serverDate: today });
  }
}

export function assertMakeupRecordDate(policy: RecordPolicy, recordDate: string): void {
  assertRecordDateInRange(recordDate);
  if (policy !== 'strict') {
    throw new AppError('MAKEUP_NOT_APPLICABLE', '轻松模式无需补卡，请直接记录该日期', 422);
  }
  const distance = daysBetweenShanghai(recordDate);
  if (distance < 1 || distance > 3) {
    throw new AppError('MAKEUP_DATE_EXPIRED', '只能补记过去三天', 422);
  }
}

export function canMutateRecord(policy: RecordPolicy, recordDate: string, today = shanghaiDate()): boolean {
  return policy === 'relaxed' || recordDate === today;
}
