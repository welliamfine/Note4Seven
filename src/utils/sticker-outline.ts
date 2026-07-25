type StickerCanvasContext = Pick<
  WechatMiniprogram.CanvasContext,
  'drawImage' | 'restore' | 'save' | 'setShadow'
>;

const OUTLINE_COLOR = '#ffffff';
const OUTLINE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-0.7, -0.7],
  [0.7, -0.7],
  [-0.7, 0.7],
  [0.7, 0.7],
];

export interface StickerDrawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const fitStickerWithin = (
  sourceWidth: number,
  sourceHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  padding: number,
): StickerDrawRect => {
  const safeWidth = Math.max(1, sourceWidth);
  const safeHeight = Math.max(1, sourceHeight);
  const availableWidth = Math.max(1, canvasWidth - padding * 2);
  const availableHeight = Math.max(1, canvasHeight - padding * 2);
  const scale = Math.min(availableWidth / safeWidth, availableHeight / safeHeight);
  const width = safeWidth * scale;
  const height = safeHeight * scale;
  return {
    x: (canvasWidth - width) / 2,
    y: (canvasHeight - height) / 2,
    width,
    height,
  };
};

export const drawStickerWithOutline = (
  context: StickerCanvasContext,
  imagePath: string,
  x: number,
  y: number,
  width: number,
  height: number,
  outlineWidth = 8,
) => {
  context.save();
  context.setShadow(0, 8, 12, 'rgba(52, 43, 35, 0.12)');
  context.drawImage(imagePath, x, y, width, height);
  context.restore();

  OUTLINE_OFFSETS.forEach(([offsetX, offsetY]) => {
    context.save();
    context.setShadow(offsetX * outlineWidth, offsetY * outlineWidth, 0, OUTLINE_COLOR);
    context.drawImage(imagePath, x, y, width, height);
    context.restore();
  });

  context.drawImage(imagePath, x, y, width, height);
};
