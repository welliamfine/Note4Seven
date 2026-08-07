import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const wxml = readFileSync('src/subpackages/module-detail/index.wxml', 'utf8');
const page = readFileSync('src/subpackages/module-detail/index.ts', 'utf8');

describe('member calendar swiper', () => {
  it('lets horizontal touch events reach the swiper', () => {
    const popoverTag = wxml.match(/<view[^>]*class="member-calendar-popover-position"[^>]*>/)?.[0];

    expect(popoverTag).toBeDefined();
    expect(popoverTag).not.toMatch(/catchtouch(?:start|move|end|cancel)=/);
    expect(wxml).toContain('class="member-calendar-swiper"');
    expect(wxml).toContain('bindchange="onMemberCalendarChange"');
  });

  it('keeps the background month swipe disabled while the popover is open', () => {
    expect(page.match(/if \(this\.data\.memberCalendarOpen\) return;/g)).toHaveLength(2);
  });
});
