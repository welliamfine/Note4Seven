import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';

const root = process.cwd();
const source = join(root, 'src');
const dist = join(root, 'dist');

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    files.push(...(entry.isDirectory() ? await walk(path) : [path]));
  }
  return files;
}

const files = await walk(dist);
const sourceFiles = await walk(source);
const failures = [];
const allowedFontSizes = new Set([20, 24, 28, 32, 36]);
const decorativeFontSizes = new Map([
  ['subpackages/member-management/index.wxss', new Set([90])],
  ['subpackages/invite-share/index.wxss', new Set([116])],
  ['subpackages/invite-intro/index.wxss', new Set([124])],
]);
const allowedFontWeights = new Set(['400', 'var(--font-weight-regular)']);
const normalizeCssValue = (value) => value.replaceAll(/\s+/g, '').toLowerCase();
const sharedTextColors = new Set([
  'inherit',
  '#fff',
  'var(--ink)',
  'var(--muted)',
  'var(--signal-red)',
  'var(--text-color-primary)',
  'var(--text-color-muted)',
].map(normalizeCssValue));
const textColorExceptions = new Map([
  ['app.wxss', new Set(['#c4a58e'])],
  ['custom-tab-bar/index.wxss', new Set(['#5b5651', '#dfa8a5'])],
  ['pages/home/index.wxss', new Set(['rgba(239,235,230,0.9)'])],
  ['pages/memory/index.wxss', new Set([
    '#48433e', '#6f6760', '#807970', '#c99491', '#c5a9a4', '#a49082', '#aaa29a', '#c2b4aa',
    'rgba(255,255,255,.78)',
  ])],
  ['subpackages/module-detail/index.wxss', new Set(['#48433e', '#746e68', '#524d47', '#9a8c80', '#817a72'])],
].map(([path, values]) => [path, new Set([...values].map(normalizeCssValue))]));

for (const file of files.filter((item) => extname(item) === '.json')) {
  try {
    JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    failures.push(`Invalid JSON: ${file} (${error.message})`);
  }
}

const app = JSON.parse(await readFile(join(dist, 'app.json'), 'utf8'));
const allPages = [
  ...app.pages,
  ...(app.subPackages ?? []).flatMap((subpackage) => subpackage.pages.map((page) => `${subpackage.root}/${page}`)),
];
for (const page of allPages) {
  for (const extension of ['.js', '.json', '.wxml', '.wxss']) {
    try {
      await access(join(dist, `${page}${extension}`));
    } catch {
      failures.push(`Missing page artifact: ${page}${extension}`);
    }
  }
}

for (const [name, componentPath] of Object.entries(app.usingComponents ?? {})) {
  const componentRoot = join(dist, String(componentPath).replace(/^\//, ''));
  for (const extension of ['.js', '.json', '.wxml', '.wxss']) {
    try {
      await access(`${componentRoot}${extension}`);
    } catch {
      failures.push(`Missing global component artifact for ${name}: ${componentPath}${extension}`);
    }
  }
}

for (const file of files.filter((item) => extname(item) === '.js')) {
  const sourceCode = await readFile(file, 'utf8');
  const relativeImports = [...sourceCode.matchAll(/require\(["'](\.[^"']+)["']\)/g)].map((match) => match[1]);
  for (const importPath of relativeImports) {
    const target = resolve(dirname(file), importPath);
    try {
      await access(`${target}.js`);
    } catch {
      try {
        await access(join(target, 'index.js'));
      } catch {
        failures.push(`Missing JavaScript dependency referenced by ${relative(dist, file)}: ${importPath}`);
      }
    }
  }
}

for (const file of files.filter((item) => extname(item) === '.wxml')) {
  const template = await readFile(file, 'utf8');
  const assetReferences = [...template.matchAll(/(?:src)=\"(\/assets\/[^\"]+)\"/g)].map((match) => match[1]);
  for (const asset of assetReferences) {
    try {
      await access(join(dist, asset.slice(1)));
    } catch {
      failures.push(`Missing asset referenced by ${file}: ${asset}`);
    }
  }
}

for (const file of sourceFiles.filter((item) => extname(item) === '.wxml')) {
  const template = await readFile(file, 'utf8');
  const placeholderControls = [...template.matchAll(/<(?:input|textarea)\b[^>]*\bplaceholder="[^"]*"[^>]*>/g)].map((match) => match[0]);
  placeholderControls.forEach((control) => {
    if (!control.includes('placeholder-class="text-placeholder"')) {
      failures.push(`Missing unified placeholder class in ${file}: ${control}`);
    }
  });

  const dynamicStickerImages = [...template.matchAll(/<image\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((image) => {
      const source = image.match(/\bsrc="([^"]+)"/)?.[1] ?? '';
      return source.includes('{{') && /sticker|galleryCover|item\.path/i.test(source);
    });
  dynamicStickerImages.forEach((image) => {
    if (!/\bclass="[^"]*sticker-outline-(?:small|medium|large)[^"]*"/.test(image)) {
      failures.push(`Missing sticker outline class in ${file}: ${image}`);
    }
  });
}

for (const file of sourceFiles.filter((item) => extname(item) === '.wxss')) {
  const stylesheet = await readFile(file, 'utf8');
  const relativePath = relative(source, file).replaceAll('\\', '/');
  const decorativeAllowed = decorativeFontSizes.get(relativePath) ?? new Set();
  const fontSizes = [...stylesheet.matchAll(/font-size\s*:\s*(\d+)rpx/g)].map((match) => Number(match[1]));
  fontSizes.forEach((fontSize) => {
    if (!allowedFontSizes.has(fontSize) && !decorativeAllowed.has(fontSize)) {
      failures.push(`Non-standard font size in ${relativePath}: ${fontSize}rpx`);
    }
  });
  const fontWeights = [...stylesheet.matchAll(/font-weight\s*:\s*([^;}]+)/g)].map((match) => match[1].trim());
  fontWeights.forEach((fontWeight) => {
    if (!allowedFontWeights.has(fontWeight)) {
      failures.push(`Non-standard font weight in ${relativePath}: ${fontWeight}`);
    }
  });
  const allowedFileColors = textColorExceptions.get(relativePath) ?? new Set();
  const textColors = [...stylesheet.matchAll(/(?:^|[;{}])\s*color\s*:\s*([^;}]+)/gm)]
    .map((match) => normalizeCssValue(match[1]));
  textColors.forEach((textColor) => {
    if (!sharedTextColors.has(textColor) && !allowedFileColors.has(textColor)) {
      failures.push(`Non-standard text color in ${relativePath}: ${textColor}`);
    }
  });
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Validated ${allPages.length} pages, ${files.length} build artifacts, and all static asset references.`);
