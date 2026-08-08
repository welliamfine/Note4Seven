import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tabBar = readFileSync('src/custom-tab-bar/index.ts', 'utf8');
const home = readFileSync('src/pages/home/index.ts', 'utf8');

describe('discover navigation', () => {
  it('switches to the standalone discover tab before delegating to a tab host', () => {
    expect(tabBar).toContain("const DISCOVER_PAGE_PATH = '/pages/discover/index';");
    expect(tabBar).toMatch(/if \(index === 2\) \{[\s\S]*?wx\.switchTab\(\{ url: DISCOVER_PAGE_PATH \}\);[\s\S]*?return;/);
  });

  it('redirects home swiper attempts to the standalone discover page', () => {
    expect(home).toContain("const DISCOVER_PAGE_PATH = '/pages/discover/index';");
    expect(home).toMatch(/onPrimarySwiperChange\([\s\S]*?if \(index === 2\) \{[\s\S]*?wx\.switchTab\(\{ url: DISCOVER_PAGE_PATH \}\);[\s\S]*?return;/);
    expect(home).not.toContain("pageVariant: 'coming_soon'");
  });
});
