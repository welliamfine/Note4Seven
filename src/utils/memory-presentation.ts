import type { MemoryView } from '../services/api';
import { addDays, buildMonthGrid, monthLabel, weekRangeLabel } from './date';

export interface MemoryMetricPresentation {
  value: number;
  unit: string;
  label: string;
}

export interface MemoryCalendarCellPresentation {
  date: string;
  day: number;
  inMonth: boolean;
  future: boolean;
  level: number;
  stickerPath: string;
  ariaLabel: string;
}

export interface MemoryWeekCellPresentation {
  date: string;
  weekday: string;
  recordCount: number;
  countLabel: string;
  level: number;
}

export interface MemoryPresentation {
  periodLabel: string;
  scopeLabel: string;
  statusLabel: string;
  summaryTitle: string;
  summarySubtitle: string;
  latestStickerPath: string;
  reportActionLabel: string;
  hasData: boolean;
  metrics: MemoryMetricPresentation[];
  calendarCells: MemoryCalendarCellPresentation[];
  weekCells: MemoryWeekCellPresentation[];
  activitySummary: string;
  timeSummary: string;
}

export function buildMemoryPresentation(view: MemoryView, today: string): MemoryPresentation {
  const hasData = view.momentCount > 0;
  const isMonth = view.reportMode === 'month';
  const periodLabel = isMonth ? monthLabel(view.periodKey) : weekRangeLabel(view.periodStart);
  const scopeLabel = view.moduleName || '全部模块';
  const streakValue = isMonth ? view.longestStreakDays : view.currentStreakDays;
  const thirdMetric: MemoryMetricPresentation = view.hasPartnerModules
    ? {
        value: view.jointCompletedDays,
        unit: '天',
        label: '共同完成',
      }
    : {
        value: view.momentCount,
        unit: '次',
        label: '记录次数',
      };
  const metrics: MemoryMetricPresentation[] = [
    {
      value: view.recordedDays,
      unit: '天',
      label: '记录天数',
    },
    {
      value: streakValue,
      unit: '天',
      label: '连续天数',
    },
    thirdMetric,
  ];

  const footprint = new Map(view.footprint.map((item) => [item.date, item]));
  const calendarCells = isMonth
    ? buildMonthGrid(view.periodKey, 0).map((cell) => {
        const item = footprint.get(cell.date);
        const recordCount = item?.recordCount ?? 0;
        return {
          date: cell.date,
          day: cell.day,
          inMonth: cell.inMonth,
          future: cell.date > today,
          level: item?.level ?? 0,
          stickerPath: item?.stickerPath ?? '',
          ariaLabel: `${cell.day}日，${recordCount ? `${recordCount}次记录` : '没有记录'}`,
        };
      })
    : [];
  const weekdayLabels = ['一', '二', '三', '四', '五', '六', '日'];
  const weekCells = isMonth ? [] : weekdayLabels.map((weekday, index) => {
    const date = addDays(view.periodStart, index);
    const item = footprint.get(date);
    const recordCount = item?.recordCount ?? 0;
    return {
      date,
      weekday,
      recordCount,
      countLabel: `${recordCount}次`,
      level: item?.level ?? 0,
    };
  });

  const comparisonScope = isMonth ? '上月' : '上周';
  const comparison = isMonth
    ? differencePhrase(view.longestStreakDays, view.previousLongestStreakDays, comparisonScope, '天')
    : differencePhrase(view.recordedDays, view.previousRecordedDays, comparisonScope, '天');
  const summaryTitle = `${isMonth ? '这个月' : '这一周'}，你生产了 ${view.momentCount} 张贴纸！`;
  const summarySubtitle = hasData
    ? (isMonth
        ? `连续记录 ${view.longestStreakDays} 天${comparison}`
        : `${view.recordedDays}天有记录${comparison}`)
    : '完成一次打卡后，这里会自动生成你的阶段足迹';
  const timeParts = [
    view.earliestTime ? `最早 ${view.earliestTime}` : '',
    view.latestTime ? `最晚 ${view.latestTime}` : '',
  ].filter(Boolean);

  return {
    periodLabel,
    scopeLabel,
    statusLabel: view.isCurrentPeriod ? '进行中' : '已定格',
    summaryTitle,
    summarySubtitle,
    latestStickerPath: view.latestStickerPath
      ?? [...view.items].sort((left, right) => right.recordDate.localeCompare(left.recordDate)
        || left.displayOrder - right.displayOrder)[0]?.stickerPath
      ?? '',
    reportActionLabel: `查看完整${isMonth ? '月报' : '周报'}`,
    hasData,
    metrics,
    calendarCells,
    weekCells,
    activitySummary: `${isMonth ? view.periodEnd.slice(8) : '7'}天内记录${view.momentCount}次 · ${view.recordedDays}天有记录`,
    timeSummary: timeParts.join(' · '),
  };
}

function differencePhrase(current: number, previous: number, scope: string, unit: string): string {
  const delta = current - previous;
  if (delta > 0) return `，比${scope}多 ${delta} ${unit}`;
  if (delta < 0) return `，比${scope}少 ${Math.abs(delta)} ${unit}`;
  return `，与${scope}持平`;
}
