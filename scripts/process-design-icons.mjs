import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const sourceDirectory = path.resolve('design/icon');
const mainOutputDirectory = path.resolve('src/assets/ui/custom-icons');
const featureOutputDirectory = path.resolve('src/subpackages/assets/ui/custom-icons');
const canvasSize = 64;
const contentSize = 56;
const fullPairRegions = [
  { left: 0, top: 0, width: 768, height: 1024 },
  { left: 768, top: 0, width: 768, height: 1024 },
];

const tabSources = [
  '底部tab栏-首页icon.png',
  '底部tab栏-回忆icon.png',
  '底部tab栏-发现icon.png',
  '底部tab栏-我的icon.png',
];

const modeSource = '奖励中心icon-打卡模式icon-记录模式icon-购物中心icon.png';
const mainIcons = [
  {
    sourceName: '首页新增模块icon.png',
    outputName: 'home-add',
    regions: fullPairRegions,
  },
  {
    sourceName: modeSource,
    outputName: 'mode-checkin',
    regions: [
      { left: 768, top: 0, width: 384, height: 512 },
      { left: 1152, top: 0, width: 384, height: 512 },
    ],
  },
  {
    sourceName: modeSource,
    outputName: 'mode-record',
    regions: [
      { left: 0, top: 512, width: 384, height: 512 },
      { left: 384, top: 512, width: 384, height: 512 },
    ],
  },
  {
    sourceName: '日历详情页-待办icon.png',
    outputName: 'profile-notifications',
    regions: fullPairRegions,
  },
  {
    sourceName: '我的界面-隐私icon.png',
    outputName: 'profile-privacy',
    regions: fullPairRegions,
  },
  {
    sourceName: '我的界面-回收站icon.png',
    outputName: 'profile-recycle',
    regions: fullPairRegions,
  },
];

const featureIcons = [
  ['日历详情页-待办icon.png', 'module-todo'],
  ['日历详情页-彩蛋设置icon和彩蛋设置弹窗-收到的礼物icon.png', 'reward-gift'],
  ['彩蛋设置弹窗-我设定的彩蛋icon.png', 'reward-rules'],
  ['彩蛋设置-收到礼物界面-没有礼物icon.png', 'reward-empty'],
  ['日历详情界面-分享icon.png', 'detail-share'],
  ['日历详情界面-管理icon.png', 'detail-manage'],
  ['画板编辑界面-清空icon.png', 'collage-clear'],
  ['画板编辑界面-保存icon.png', 'collage-save'],
].map(([sourceName, outputName]) => ({
  sourceName,
  outputName,
  regions: fullPairRegions,
}));

async function extractState(sourcePath, region) {
  const cropped = await sharp(sourcePath)
    .extract(region)
    .png()
    .toBuffer();

  return sharp(cropped)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 8 })
    .png()
    .toBuffer({ resolveWithObject: true });
}

async function renderState(buffer, width, height, scale) {
  const resizedWidth = Math.max(1, Math.round(width * scale));
  const resizedHeight = Math.max(1, Math.round(height * scale));
  const horizontalPadding = canvasSize - resizedWidth;
  const verticalPadding = canvasSize - resizedHeight;

  return sharp(buffer)
    .resize(resizedWidth, resizedHeight, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .extend({
      left: Math.floor(horizontalPadding / 2),
      right: Math.ceil(horizontalPadding / 2),
      top: Math.floor(verticalPadding / 2),
      bottom: Math.ceil(verticalPadding / 2),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

async function createStatePair(sourceName, regions = fullPairRegions) {
  const sourcePath = path.join(sourceDirectory, sourceName);
  const [defaultIcon, selectedIcon] = await Promise.all(
    regions.map((region) => extractState(sourcePath, region)),
  );
  const largestEdge = Math.max(
    defaultIcon.info.width,
    defaultIcon.info.height,
    selectedIcon.info.width,
    selectedIcon.info.height,
  );
  const scale = contentSize / largestEdge;

  return Promise.all([
    renderState(defaultIcon.data, defaultIcon.info.width, defaultIcon.info.height, scale),
    renderState(selectedIcon.data, selectedIcon.info.width, selectedIcon.info.height, scale),
  ]);
}

async function writeSprite(cells, columns, outputPath) {
  const rows = Math.ceil(cells.length / columns);
  await sharp({
    create: {
      width: columns * canvasSize,
      height: rows * canvasSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(cells.map((input, index) => ({
      input,
      left: (index % columns) * canvasSize,
      top: Math.floor(index / columns) * canvasSize,
    })))
    .png({ compressionLevel: 9, palette: true, quality: 100, colours: 64, dither: 0 })
    .toFile(outputPath);
}

async function writeIconPair(icon, outputDirectory) {
  await writeSprite(
    await createStatePair(icon.sourceName, icon.regions),
    2,
    path.join(outputDirectory, `${icon.outputName}.png`),
  );
}

await Promise.all([
  mkdir(mainOutputDirectory, { recursive: true }),
  mkdir(featureOutputDirectory, { recursive: true }),
]);

const sourceNames = await readdir(sourceDirectory);
const requiredSourceNames = new Set([
  ...tabSources,
  ...mainIcons.map(({ sourceName }) => sourceName),
  ...featureIcons.map(({ sourceName }) => sourceName),
]);
for (const sourceName of requiredSourceNames) {
  if (!sourceNames.includes(sourceName)) throw new Error(`Missing icon source: ${sourceName}`);
}

const tabPairs = await Promise.all(tabSources.map((sourceName) => createStatePair(sourceName)));
await writeSprite(
  [...tabPairs.map(([defaultIcon]) => defaultIcon), ...tabPairs.map(([, selectedIcon]) => selectedIcon)],
  4,
  path.join(mainOutputDirectory, 'tab-sprite.png'),
);

for (const icon of mainIcons) await writeIconPair(icon, mainOutputDirectory);
for (const icon of featureIcons) await writeIconPair(icon, featureOutputDirectory);

const generatedOutputNames = [
  'tab-home',
  'tab-memory',
  'tab-discover',
  'tab-profile',
  ...mainIcons.map(({ outputName }) => outputName),
  ...featureIcons.map(({ outputName }) => outputName),
];
for (const outputName of generatedOutputNames) {
  await Promise.all([
    rm(path.join(mainOutputDirectory, `${outputName}-default.png`), { force: true }),
    rm(path.join(mainOutputDirectory, `${outputName}-selected.png`), { force: true }),
    rm(path.join(featureOutputDirectory, `${outputName}-default.png`), { force: true }),
    rm(path.join(featureOutputDirectory, `${outputName}-selected.png`), { force: true }),
  ]);
}
