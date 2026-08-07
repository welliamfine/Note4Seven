import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tabBar = readFileSync('src/custom-tab-bar/index.ts', 'utf8');
const tabBarTemplate = readFileSync('src/custom-tab-bar/index.wxml', 'utf8');
const tabBarStyles = readFileSync('src/custom-tab-bar/index.wxss', 'utf8');
const detailTemplate = readFileSync('src/subpackages/module-detail/index.wxml', 'utf8');
const detailStyles = readFileSync('src/subpackages/module-detail/index.wxss', 'utf8');
const collectionTemplate = readFileSync('src/subpackages/reward-collection/index.wxml', 'utf8');
const discoverTemplate = readFileSync('src/pages/discover/index.wxml', 'utf8');
const homeTemplate = readFileSync('src/pages/home/index.wxml', 'utf8');
const homeStyles = readFileSync('src/pages/home/index.wxss', 'utf8');
const profileTemplate = readFileSync('src/pages/profile/index.wxml', 'utf8');
const profileStyles = readFileSync('src/pages/profile/index.wxss', 'utf8');
const collageTemplate = readFileSync('src/subpackages/memory-collage-editor/index.wxml', 'utf8');
const collageStyles = readFileSync('src/subpackages/memory-collage-editor/index.wxss', 'utf8');

const mainIconNames = [
  'home-add',
  'mode-checkin',
  'mode-record',
  'profile-notifications',
  'profile-privacy',
  'profile-recycle',
];

const featureIconNames = [
  'module-todo',
  'reward-gift',
  'reward-rules',
  'reward-empty',
  'detail-share',
  'detail-manage',
  'collage-clear',
  'collage-save',
];

function expectPairSprite(filePath: string) {
  const image = readFileSync(filePath);
  expect(image.subarray(1, 4).toString('ascii')).toBe('PNG');
  expect(image.readUInt32BE(16)).toBe(128);
  expect(image.readUInt32BE(20)).toBe(64);
}

describe('custom icon states', () => {
  it('ships compact state sprites for every supplied icon', () => {
    expect(existsSync('src/assets/ui/custom-icons/tab-sprite.png')).toBe(true);
    for (const iconName of mainIconNames) {
      const filePath = `src/assets/ui/custom-icons/${iconName}.png`;
      expect(existsSync(filePath)).toBe(true);
      expectPairSprite(filePath);
    }
    for (const iconName of featureIconNames) {
      const filePath = `src/subpackages/assets/ui/custom-icons/${iconName}.png`;
      expect(existsSync(filePath)).toBe(true);
      expectPairSprite(filePath);
    }
  });

  it('switches all four tab icons with the selected tab index', () => {
    expect(tabBar.match(/pagePath:/g)).toHaveLength(4);
    expect(tabBarTemplate).toContain('/assets/ui/custom-icons/tab-sprite.png');
    expect(tabBarTemplate).toContain("selected === index ? 'tab-icon-sprite-selected' : ''");
    expect(tabBarStyles).toContain('height: 124rpx;');
    expect(tabBarStyles).toContain('flex: 0 0 58rpx;');
    expect(tabBarStyles).toContain('.tab-item .tab-icon-sprite-selected { top: -58rpx; }');
  });

  it('uses pressed states for interactive detail icons and the supplied empty state icon', () => {
    expect(detailTemplate.match(/hover-class="icon-button-selected"/g)).toHaveLength(4);
    expect(detailTemplate).toContain('/subpackages/assets/ui/custom-icons/module-todo.png');
    expect(detailTemplate).toContain('/subpackages/assets/ui/custom-icons/reward-gift.png');
    expect(detailTemplate).toContain('/subpackages/assets/ui/custom-icons/reward-rules.png');
    expect(collectionTemplate).toContain('/subpackages/assets/ui/custom-icons/reward-empty.png');
    expect(detailStyles).toContain('grid-template-columns: 78rpx minmax(0, 1fr);');
    expect(detailStyles).toContain('width: 56rpx;');
    expect(detailStyles).toContain('width:44rpx; height:44rpx;');
  });

  it('reuses the selected discover tab artwork on both discover views', () => {
    expect(discoverTemplate).toContain('/assets/ui/custom-icons/tab-sprite.png');
    expect(homeTemplate).toContain('/assets/ui/custom-icons/tab-sprite.png');
  });

  it('switches the new home, mode, detail, editor, and profile icons to their selected cells', () => {
    expect(homeTemplate).toContain('/assets/ui/custom-icons/home-add.png');
    expect(homeTemplate).toContain('/assets/ui/custom-icons/mode-record.png');
    expect(homeTemplate).toContain('/assets/ui/custom-icons/mode-checkin.png');
    expect(homeStyles).toContain('.floating-add.control-pressed .home-state-icon-sprite');
    expect(homeStyles).not.toContain('.record-policy-selected .home-state-icon-sprite');
    expect(homeStyles).toContain('.floating-add .home-state-icon {');
    expect(homeStyles).toContain('width: 84rpx;');
    expect(homeStyles).toContain('.record-policy-option .home-state-icon {');
    expect(homeStyles).toContain('width: 58rpx;');

    expect(detailTemplate).toContain('/subpackages/assets/ui/custom-icons/detail-share.png');
    expect(detailTemplate).toContain('/subpackages/assets/ui/custom-icons/detail-manage.png');
    expect(detailStyles).toContain('.control-pressed .detail-action-icon .state-icon-sprite');

    expect(collageTemplate).toContain('/subpackages/assets/ui/custom-icons/collage-clear.png');
    expect(collageTemplate).toContain('/subpackages/assets/ui/custom-icons/collage-save.png');
    expect(collageStyles).toContain('.editor-control-pressed .editor-action-icon-sprite');

    for (const template of [profileTemplate, homeTemplate]) {
      expect(template).toContain('/assets/ui/custom-icons/profile-notifications.png');
      expect(template).toContain('/assets/ui/custom-icons/profile-privacy.png');
      expect(template).toContain('/assets/ui/custom-icons/profile-recycle.png');
    }
    expect(profileStyles).toContain('.profile-menu-selected .profile-state-icon-sprite');
    expect(profileStyles).toContain('grid-template-columns: 56rpx 1fr;');
    expect(profileStyles).toContain('gap: 18rpx;');
    expect(profileStyles).toContain('width: 56rpx;');
  });
});
