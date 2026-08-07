import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = resolve(root, 'design');
const outputRoot = resolve(argument('out') ?? 'artifacts/memory-collage-assets');
const artifactsRoot = resolve(root, 'artifacts');
const migrationPath = argument('migration')
  ? resolve(argument('migration'))
  : resolve(root, 'server/migrations/020_memory_collage_assets.sql');
const categoryCollator = new Intl.Collator('zh-CN', { numeric: true });
const sharedEditableBounds = Object.freeze({
  left: 0.045,
  top: 0.13,
  right: 0.955,
  bottom: 0.945,
});

if (!outputRoot.startsWith(`${artifactsRoot}${sep}`)) {
  throw new Error(`Generated output must stay inside ${artifactsRoot}`);
}
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const boardSources = (await readdir(join(sourceRoot, 'board'), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.png')
  .map((entry) => entry.name)
  .sort(categoryCollator.compare);
const stickerCategoryEntries = (await readdir(join(sourceRoot, 'stickers'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .sort((left, right) => categoryCollator.compare(left.name, right.name));

const boards = [];
for (const [index, sourceName] of boardSources.entries()) {
  const assetKey = `board-${String(index + 1).padStart(2, '0')}`;
  const sourcePath = join(sourceRoot, 'board', sourceName);
  const metadata = await sharp(sourcePath).metadata();
  if (!metadata.width || !metadata.height) throw new Error(`Invalid board dimensions: ${sourceName}`);
  const editableBounds = sharedEditableBounds;
  const originalFile = `memory-collage/boards/${assetKey}.webp`;
  const thumbnailFile = `memory-collage/boards/${assetKey}-thumb.webp`;
  await writeBoard(sourcePath, join(outputRoot, originalFile), false);
  await writeBoard(sourcePath, join(outputRoot, thumbnailFile), true);
  boards.push({
    assetKey,
    name: '',
    category: 'default',
    originalFile,
    thumbnailFile,
    width: metadata.width,
    height: metadata.height,
    editableBounds,
    source: relative(sourceRoot, sourcePath),
    sortOrder: index,
  });
}

const stickers = [];
for (const [categoryIndex, categoryEntry] of stickerCategoryEntries.entries()) {
  const categoryPath = join(sourceRoot, 'stickers', categoryEntry.name);
  const categoryFiles = (await readdir(categoryPath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.png')
    .map((entry) => entry.name)
    .sort(categoryCollator.compare);
  const categoryKey = `category-${String(categoryIndex + 1).padStart(2, '0')}`;
  for (const [fileIndex, sourceName] of categoryFiles.entries()) {
    const assetKey = `sticker-${String(categoryIndex + 1).padStart(2, '0')}-${String(fileIndex + 1).padStart(3, '0')}`;
    const sourcePath = join(categoryPath, sourceName);
    const metadata = await sharp(sourcePath).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`Invalid sticker dimensions: ${sourcePath}`);
    const originalFile = `memory-collage/stickers/${categoryKey}/${assetKey}.webp`;
    const thumbnailFile = `memory-collage/stickers/${categoryKey}/${assetKey}-thumb.webp`;
    await writeSticker(sourcePath, join(outputRoot, originalFile), false);
    await writeSticker(sourcePath, join(outputRoot, thumbnailFile), true);
    const defaultWidth = 0.22;
    const defaultHeight = clamp(defaultWidth * metadata.height / metadata.width, 0.08, 0.34);
    stickers.push({
      assetKey,
      name: '',
      category: categoryEntry.name,
      categoryKey,
      originalFile,
      thumbnailFile,
      defaultWidth,
      defaultHeight: ratio(defaultHeight),
      source: relative(sourceRoot, sourcePath),
      sortOrder: stickers.length,
    });
  }
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  editableBounds: sharedEditableBounds,
  boards,
  stickers,
};
await writeFile(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await mkdir(resolve(migrationPath, '..'), { recursive: true });
await writeFile(migrationPath, migrationSql(boards, stickers), 'utf8');
console.log(`[memory-collage-assets] boards=${boards.length} stickers=${stickers.length}`);
console.log(`[memory-collage-assets] output=${outputRoot}`);
console.log(`[memory-collage-assets] migration=${migrationPath}`);

function argument(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function writeBoard(sourcePath, outputPath, thumbnail) {
  await mkdir(resolve(outputPath, '..'), { recursive: true });
  let image = sharp(sourcePath).ensureAlpha();
  if (thumbnail) image = image.resize({ width: 360, height: 360, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
  await image.webp({ quality: 92, alphaQuality: 100, effort: 5 }).toFile(outputPath);
}

async function writeSticker(sourcePath, outputPath, thumbnail) {
  await mkdir(resolve(outputPath, '..'), { recursive: true });
  let image = sharp(sourcePath).ensureAlpha();
  image = image.resize({ width: thumbnail ? 180 : 640, height: thumbnail ? 180 : 640, fit: 'inside', withoutEnlargement: true });
  await image.webp({ quality: 92, alphaQuality: 100, effort: 5 }).toFile(outputPath);
}

function migrationSql(boards, stickers) {
  const lines = [
    '-- Generated by scripts/prepare-memory-collage-assets.mjs. Do not edit by hand.',
    'ALTER TABLE memory_collage_board_asset',
    '  ADD COLUMN editable_left DECIMAL(8,6) NOT NULL DEFAULT 0.045000,',
    '  ADD COLUMN editable_top DECIMAL(8,6) NOT NULL DEFAULT 0.130000,',
    '  ADD COLUMN editable_right DECIMAL(8,6) NOT NULL DEFAULT 0.955000,',
    '  ADD COLUMN editable_bottom DECIMAL(8,6) NOT NULL DEFAULT 0.945000;',
    '',
    'INSERT INTO memory_collage_board_asset',
    '  (asset_key, name, category, thumbnail_file_key, original_file_key, width, height, editable_left, editable_top, editable_right, editable_bottom, status, sort_order)',
    'VALUES',
    boards.map((board, index) => `  (${sql(board.assetKey)}, ${sql(board.name)}, ${sql(board.category)}, ${sql(board.thumbnailFile)}, ${sql(board.originalFile)}, ${board.width}, ${board.height}, ${board.editableBounds.left.toFixed(6)}, ${board.editableBounds.top.toFixed(6)}, ${board.editableBounds.right.toFixed(6)}, ${board.editableBounds.bottom.toFixed(6)}, 'active', ${board.sortOrder})${index === boards.length - 1 ? '' : ','}`).join('\n'),
    'ON DUPLICATE KEY UPDATE',
    '  thumbnail_file_key = VALUES(thumbnail_file_key), original_file_key = VALUES(original_file_key),',
    '  width = VALUES(width), height = VALUES(height), editable_left = VALUES(editable_left),',
    '  editable_top = VALUES(editable_top), editable_right = VALUES(editable_right), editable_bottom = VALUES(editable_bottom),',
    '  status = VALUES(status), sort_order = VALUES(sort_order);',
    '',
    'INSERT INTO memory_collage_sticker_asset',
    '  (asset_key, name, category, thumbnail_file_key, original_file_key, default_width, default_height, status, sort_order)',
    'VALUES',
    stickers.map((sticker, index) => `  (${sql(sticker.assetKey)}, ${sql(sticker.name)}, ${sql(sticker.category)}, ${sql(sticker.thumbnailFile)}, ${sql(sticker.originalFile)}, ${sticker.defaultWidth.toFixed(6)}, ${sticker.defaultHeight.toFixed(6)}, 'active', ${sticker.sortOrder})${index === stickers.length - 1 ? '' : ','}`).join('\n'),
    'ON DUPLICATE KEY UPDATE',
    '  thumbnail_file_key = VALUES(thumbnail_file_key), original_file_key = VALUES(original_file_key),',
    '  default_width = VALUES(default_width), default_height = VALUES(default_height),',
    '  status = VALUES(status), sort_order = VALUES(sort_order);',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function ratio(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
