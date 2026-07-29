import type { RecordPolicy } from '../types/domain';
import { differenceInDays, shanghaiDate } from './date';

export const RECORD_DATE_MIN = '1900-01-01';
export const RECORD_DATE_MAX = '2099-12-31';

export function isRecordDateInRange(recordDate: string): boolean {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(recordDate)
    ? new Date(`${recordDate}T00:00:00Z`)
    : null;
  return Boolean(parsed
    && !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === recordDate
    && recordDate >= RECORD_DATE_MIN
    && recordDate <= RECORD_DATE_MAX);
}

export function canCreateNormalRecord(policy: RecordPolicy, recordDate: string, today = shanghaiDate()): boolean {
  return isRecordDateInRange(recordDate) && (policy === 'relaxed' || recordDate === today);
}

export function canSubmitMakeup(policy: RecordPolicy, recordDate: string, today = shanghaiDate()): boolean {
  const distance = differenceInDays(recordDate, today);
  return policy === 'strict' && isRecordDateInRange(recordDate) && distance >= -3 && distance <= -1;
}

export function canMutateRecord(policy: RecordPolicy, recordDate: string, today = shanghaiDate()): boolean {
  return isRecordDateInRange(recordDate) && (policy === 'relaxed' || recordDate === today);
}
