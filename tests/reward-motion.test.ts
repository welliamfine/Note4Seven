import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REWARD_MOTION } from '../src/utils/reward-motion';

const wxml = readFileSync('src/subpackages/module-detail/index.wxml', 'utf8');
const styles = readFileSync('src/subpackages/module-detail/index.wxss', 'utf8');
const page = readFileSync('src/subpackages/module-detail/index.ts', 'utf8');

describe('reward motion', () => {
  it('keeps the card flip slower than the original transition', () => {
    expect(REWARD_MOTION.flipDuration).toBeGreaterThan(440);
    expect(REWARD_MOTION.collectDuration).toBeGreaterThan(REWARD_MOTION.flipDuration);
    expect(styles).toContain('transition:transform var(--reward-flip-duration)');
  });

  it('uses one motion phase flow for preview and real reward dialogs', () => {
    expect(page.match(/rewardMotionPhase: 'entering'/g)?.length).toBeGreaterThanOrEqual(2);
    expect(wxml).toContain('reward-motion-{{rewardMotionPhase}}');
    expect(wxml).toContain('bindtap="collectReward"');
  });

  it('renders and animates the Figma celebration layers', () => {
    expect(wxml).toContain('/subpackages/reward-assets/reward-rays.svg');
    expect(wxml).toContain('/subpackages/reward-assets/reward-ribbon-left.svg');
    expect(wxml).toContain('/subpackages/reward-assets/reward-ribbon-right.svg');
    expect(wxml).toContain('/subpackages/reward-assets/reward-confetti.svg');
    expect(styles).toContain('@keyframes reward-confetti-fall');
    expect(styles).toContain('@keyframes reward-card-collect');
  });

  it('opens the configured reward list as a covering bottom sheet', () => {
    expect(wxml).toContain("reward-rule-list-overlay sheet-motion-overlay {{rewardRuleListClosing ? 'sheet-motion-closing' : ''}}");
    expect(wxml).toContain("reward-settings-sheet safe-bottom sheet-motion-panel {{rewardRuleListClosing ? 'sheet-motion-closing' : ''}}");
    expect(styles).toContain('.reward-rule-list-overlay { z-index:116; }');
    expect(page).toContain('async dismissRewardRuleList()');
    expect(page).toContain('await waitForSheetMotion()');
  });

  it('keeps reward rule action buttons equal and inside their card', () => {
    expect(styles).toContain('.reward-rule-actions { width:100%; margin-top:16rpx; box-sizing:border-box; display:flex;');
    expect(styles).toContain('.reward-row-button { width:0; min-width:0;');
    expect(styles).toContain('flex:1 1 0;');
  });

  it('closes and resets the reward form after a successful save', () => {
    const dismissSettings = page.slice(
      page.indexOf('async dismissRewardSettings()'),
      page.indexOf('closeRewardSettings()'),
    );
    const saveReward = page.slice(
      page.indexOf('async saveRewardRule()'),
      page.indexOf('async cancelRewardRule('),
    );

    expect(dismissSettings).toContain("rewardTargetIndex: 0");
    expect(dismissSettings).toContain("rewardStreakDays: '7'");
    expect(dismissSettings).toContain("rewardPrizeTitle: ''");
    expect(dismissSettings).toContain("rewardPrizeDescription: ''");
    expect(dismissSettings).toContain('rewardProbability: 80');
    expect(dismissSettings).toContain('rewardAgreement: false');
    expect(saveReward).toContain("rewardCoverMediaId: ''");
    expect(saveReward).toContain('await this.dismissRewardSettings()');
  });
});
