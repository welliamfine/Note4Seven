import { describe, expect, it } from 'vitest';
import { drawStickerWithOutline, fitStickerWithin } from '../src/utils/sticker-outline';

describe('sticker outline canvas rendering', () => {
  it('centers a sticker without changing its aspect ratio', () => {
    const rect = fitStickerWithin(393, 632, 750, 1000, 40);

    expect(rect.y).toBe(40);
    expect(rect.height).toBe(920);
    expect(rect.x).toBeCloseTo((750 - rect.width) / 2);
    expect(rect.width / rect.height).toBeCloseTo(393 / 632);
  });

  it('draws a shadow, eight white edge passes, and the original image', () => {
    const shadows: Array<[number, number, number, string]> = [];
    const drawCalls: Array<[string, number, number, number, number]> = [];
    let saves = 0;
    let restores = 0;
    const context = {
      save: () => { saves += 1; },
      restore: () => { restores += 1; },
      setShadow: (x: number, y: number, blur: number, color: string) => shadows.push([x, y, blur, color]),
      drawImage: (path: string, x: number, y: number, width: number, height: number) => {
        drawCalls.push([path, x, y, width, height]);
      },
    } as unknown as WechatMiniprogram.CanvasContext;

    drawStickerWithOutline(context, 'sticker.png', 10, 20, 144, 196, 10);

    expect(shadows).toHaveLength(9);
    expect(shadows[0]).toEqual([0, 8, 12, 'rgba(52, 43, 35, 0.12)']);
    expect(shadows.slice(1).map(([x, y, blur, color]) => [x, y, blur, color])).toEqual([
      [-10, 0, 0, '#ffffff'],
      [10, 0, 0, '#ffffff'],
      [0, -10, 0, '#ffffff'],
      [0, 10, 0, '#ffffff'],
      [-7, -7, 0, '#ffffff'],
      [7, -7, 0, '#ffffff'],
      [-7, 7, 0, '#ffffff'],
      [7, 7, 0, '#ffffff'],
    ]);
    expect(drawCalls).toHaveLength(10);
    expect(drawCalls.every((call) => call.join(',') === 'sticker.png,10,20,144,196')).toBe(true);
    expect(saves).toBe(9);
    expect(restores).toBe(9);
  });
});
