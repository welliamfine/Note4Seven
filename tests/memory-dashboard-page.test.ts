import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const wxml = readFileSync('src/pages/memory/index.wxml', 'utf8');
const page = readFileSync('src/pages/memory/index.ts', 'utf8');
const styles = readFileSync('src/pages/memory/index.wxss', 'utf8');
const primaryWxml = readFileSync('src/pages/home/index.wxml', 'utf8');
const primaryPage = readFileSync('src/pages/home/index.ts', 'utf8');

describe('memory dashboard page contract', () => {
  it('contains every primary Figma section and interaction state', () => {
    expect(wxml).toContain('周报');
    expect(wxml).toContain('月报');
    expect(wxml).toContain('report-segment-thumb');
    expect(styles).toContain('transition: transform 260ms');
    expect(primaryWxml).toContain('report-segment-thumb');
    expect(wxml).toContain('summary-card');
    expect(wxml).toContain('core-metrics');
    expect(wxml).toContain('回忆拼贴');
    expect(wxml).toContain('month-footprint');
    expect(wxml).toContain('week-footprint');
    expect(wxml).toContain('memory-select-sheet');
    expect(page).toContain('fetchMemoryView(');
    expect(page).toContain('buildMemoryPresentation(view');
  });

  it('uses the provided board asset and data-driven heat levels', () => {
    expect(wxml).toContain('/assets/ui/memory-collage-board.webp');
    expect(wxml).toContain('heat-level-{{item.level}}');
    expect(styles).toContain('.heat-level-4');
    const boardSize = statSync('src/assets/ui/memory-collage-board.webp').size;
    expect(boardSize).toBeGreaterThan(20_000);
    expect(boardSize).toBeLessThan(256_000);
    expect(wxml).not.toContain('23 个瞬间');
    expect(wxml).not.toContain('18 天');
    expect(wxml).not.toContain('item.stickerPath && item.inMonth');
    expect(primaryWxml).not.toContain('item.stickerPath && item.inMonth');
    expect(wxml).toContain('/assets/ui/memory-default-sticker.png');
    expect(primaryWxml).toContain('/assets/ui/memory-default-sticker.png');
    expect(wxml).toContain('class="summary-sticker-image sticker-outline-medium"');
    expect(styles).toContain('margin-top: 14rpx');
    expect(styles).toContain('right: 48rpx');
    expect(styles).toContain('.summary-meta {\n  color: var(--text-color-muted);\n  font-size: var(--font-size-secondary);');
    expect(wxml).not.toContain('{{item.note}}');
    expect(primaryWxml).not.toContain('{{item.note}}');
    expect(styles).not.toContain('.metric-note');
    expect(styles).toMatch(/\.metric-number\s*\{[\s\S]*?font-family:\s*var\(--font-family-base\);/);
    expect(styles).toContain('.metric-unit {\n  margin-left: 4rpx;\n  font-family: var(--font-family-base);');
    const defaultStickerSize = statSync('src/assets/ui/memory-default-sticker.png').size;
    expect(defaultStickerSize).toBeGreaterThan(10_000);
    expect(defaultStickerSize).toBeLessThan(64_000);
  });

  it('renders the same dashboard from the embedded primary-tab entry', () => {
    expect(primaryWxml).toContain('setMemoryReportMode');
    expect(primaryWxml).toContain('memorySummaryTitle');
    expect(primaryWxml).toContain('statusBarHeight');
    expect(primaryWxml).toContain('回忆拼贴');
    expect(primaryWxml).toContain('heat-level-{{item.level}}');
    expect(primaryWxml).not.toContain('本周概览');
    expect(primaryWxml).not.toContain('这个月还没有贴纸');
    expect(primaryPage).toContain('buildMemoryPresentation(view');
    expect(primaryPage).toContain('this.data.memoryReportMode');
  });

  it('animates changed report text, collage boards, and heatmaps while retaining cached views', () => {
    expect(wxml).toContain('summaryPeriodMotionClass');
    expect(wxml).toContain('summaryCountMotionClass');
    expect(wxml).toContain('metricValueMotionClasses[index]');
    expect(primaryWxml).toContain('memorySummaryPeriodMotionClass');
    expect(primaryWxml).toContain('memorySummaryCountMotionClass');
    expect(primaryWxml).toContain('memoryMetricValueMotionClasses[index]');
    for (const markup of [wxml, primaryWxml]) {
      expect(markup).toContain('memoryBoardPhase');
      expect(markup).toContain('memoryHeatmapPhase');
      expect(markup).not.toContain('memoryTextMotionClass');
    }
    expect(page).toContain('runMemoryReportTransition(query');
    expect(page).toContain('memoryReportMotionState(phase');
    expect(primaryPage).toContain('runMemoryReportTransition(query');
  });

  it('keeps bubbles and section titles fixed while animating only their changing text', () => {
    expect(wxml).toContain('summary-meta {{summaryMetaMotionClass}}');
    expect(wxml).toContain('summary-action {{summaryActionMotionClass}}');
    expect(primaryWxml).toContain('summary-meta {{memorySummaryMetaMotionClass}}');
    expect(primaryWxml).toContain('summary-action {{memorySummaryActionMotionClass}}');
    expect(wxml).toContain('metric-number {{metricValueMotionClasses[index]}}');
    expect(primaryWxml).toContain('metric-number {{memoryMetricValueMotionClasses[index]}}');
    for (const markup of [wxml, primaryWxml]) {
      expect(markup).not.toContain('summary-copy {{');
      expect(markup).not.toContain('core-metrics {{');
      expect(markup).not.toContain('section-heading {{');
      expect(markup).not.toContain('summary-sticker {{memoryBoardPhase}}');
      expect(markup).not.toContain('metric-number-row {{');
      expect(markup).not.toContain('metric-unit {{');
      expect(markup).not.toContain('metric-name {{');
    }
    expect(styles).toContain('width: 220rpx');
  });

  it('keeps the change-group control mounted for shrink and layout animations', () => {
    expect(wxml).toContain('section-actions {{collageActionPhase}}');
    expect(wxml).toContain('change-button {{collageActionPhase}}');
    expect(wxml).not.toContain('wx:if="{{!hasSavedCollage}}" class="change-button');
    expect(primaryWxml).toContain('section-actions {{memoryCollageActionPhase}}');
    expect(primaryWxml).toContain('change-button {{memoryCollageActionPhase}}');
    expect(primaryPage).toContain('runMemoryCollageActionTransition(');
  });

  it('orders the memory modules as report data, collage, then heatmap', () => {
    for (const markup of [wxml, primaryWxml]) {
      const collage = markup.indexOf('class="memory-section collage-section"');
      const heatmap = markup.indexOf('class="memory-section footprint-section"');
      const data = markup.indexOf('class="summary-card memory-glass"');

      expect(data).toBeGreaterThan(-1);
      expect(collage).toBeGreaterThan(data);
      expect(heatmap).toBeGreaterThan(collage);
    }
  });

  it('keeps the embedded memory page scrollable beneath a fixed compact header', () => {
    const memoryPageStart = primaryWxml.indexOf('<view class="page-shell memory-page">');
    const fixedHeaderStart = primaryWxml.indexOf('<view class="memory-fixed-header content-layer"');
    const memoryScrollStart = primaryWxml.indexOf('<scroll-view class="primary-scroll memory-scroll content-layer"');
    expect(memoryPageStart).toBeGreaterThan(-1);
    expect(fixedHeaderStart).toBeGreaterThan(memoryPageStart);
    expect(memoryScrollStart).toBeGreaterThan(fixedHeaderStart);
    expect(memoryScrollStart).toBeGreaterThan(memoryPageStart);
    expect(primaryWxml).toContain('<text>周日</text><text>周一</text>');
    expect(primaryWxml).toContain('class="save-memory-slot"');
    expect(primaryWxml).toContain('height: calc(100vh - {{statusBarHeight}}px - 142rpx)');
    expect(primaryWxml).not.toContain('class="period-selector memory-glass"');
    expect(wxml).not.toContain('class="period-selector memory-glass"');
    expect(primaryWxml).not.toContain('　⌄');
    expect(styles).toContain('.memory-fixed-header');
    expect(styles).toContain('background: transparent');
    expect(styles).toContain('width: 112rpx !important');
    expect(styles).toContain('width: 100% !important');
    expect(styles).toContain('white-space: nowrap');
  });

  it('renders a saved board as the immutable collage background', () => {
    expect(wxml).toContain("hasSavedCollage ? 'has-saved-collage' : 'has-generated-collage'");
    expect(primaryWxml).toContain("memoryHasSavedCollage ? 'has-saved-collage' : 'has-generated-collage'");
    expect(wxml).toContain('class="saved-collage-board-background"');
    expect(primaryWxml).toContain('class="saved-collage-board-background"');
    expect(wxml).toContain('src="{{savedCollageBoardPath}}" mode="scaleToFill"');
    expect(primaryWxml).toContain('src="{{memorySavedCollageBoardPath}}" mode="scaleToFill"');
    expect(wxml).toContain('class="saved-collage-default-board"');
    expect(primaryWxml).toContain('class="saved-collage-default-board"');
    expect(wxml).toContain('src="/assets/ui/memory-collage-board.webp" mode="scaleToFill"');
    expect(styles).toContain('.collage-board-background,\n.saved-collage-default-board image {');
    expect(wxml).not.toContain('saved-collage-base');
    expect(primaryWxml).not.toContain('saved-collage-base');
    expect(styles).toMatch(/\.saved-collage-preview\s*\{[\s\S]*?overflow:\s*visible;/);
    expect(styles).toContain('width: min(100%, 690rpx)');
    expect(styles).toMatch(/\.save-memory-slot\s*\{[\s\S]*?position:\s*relative;[\s\S]*?width:\s*min\(100%, 480rpx\);/);
    expect(wxml).toContain('</view>\n          <view class="save-memory-slot">');
    expect(primaryWxml).toContain('</view>\n              <view class="save-memory-slot">');
  });

  it('preserves the generated fallback board, requested heat scale, and translucent selection sheet', () => {
    expect(styles).toContain('.collage-board-background');
    expect(styles).toContain('width: 119.181%');
    expect(styles).toContain('left: -8.007%');
    expect(styles).toContain('overflow: visible');
    expect(styles).toContain('top: 232rpx');
    expect(styles).toContain('height: 250rpx');
    expect(styles).toContain('.heat-level-0 { background: #fff; }');
    expect(styles).toContain('.heat-level-2 { background: #eae2d4; }');
    expect(styles).toContain('.heat-level-4 { background: #c6b3a2; }');
    expect(styles).not.toContain('#d7c7b7');
    expect(styles).toContain('.beta-sheet.memory-select-sheet');
    expect(styles).toContain('background: rgba(249,248,243,.85)');
  });
});
