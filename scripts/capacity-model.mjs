const values = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, raw] = item.replace(/^--/, '').split('=');
  return [key, Number(raw)];
}));
const input = {
  dau: positive(values.dau, 1_000),
  recordsPerUserPerDay: positive(values.records, 1),
  averageOriginalKiB: positive(values.originalKiB, 1_500),
  averageDerivedKiB: positive(values.derivedKiB, 500),
  retentionDays: positive(values.retentionDays, 365),
  exportsPerUserPerMonth: positive(values.exports, 0.2),
  peakFactor: positive(values.peakFactor, 4),
  mediaSeconds: positive(values.mediaSeconds, 3),
};
const dailyRecords = input.dau * input.recordsPerUserPerDay;
const dailyStorageGiB = dailyRecords * (input.averageOriginalKiB + input.averageDerivedKiB) / 1024 / 1024;
const retainedStorageGiB = dailyStorageGiB * input.retentionDays;
const averageMediaRps = dailyRecords / 86_400;
const peakMediaRps = averageMediaRps * input.peakFactor;
const concurrentMediaJobs = Math.ceil(peakMediaRps * input.mediaSeconds);
const monthlyExports = input.dau * input.exportsPerUserPerMonth;
process.stdout.write(`${JSON.stringify({
  assumptions: input,
  estimates: { dailyRecords, dailyStorageGiB, retainedStorageGiB, averageMediaRps, peakMediaRps, concurrentMediaJobs, monthlyExports },
}, null, 2)}\n`);

function positive(value, fallback) {
  if (value === undefined || Number.isNaN(value)) return fallback;
  if (value < 0) throw new Error('Capacity inputs must be non-negative');
  return value;
}
