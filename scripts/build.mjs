import { build } from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceDir = join(root, 'src');
const outputDir = join(root, 'dist');
const watch = process.argv.includes('--watch');
const apiModeArgument = process.argv.find((argument) => argument.startsWith('--api-mode='));
const apiMode = apiModeArgument?.split('=')[1];
if (!apiMode) {
  throw new Error('Missing --api-mode. Use an explicit npm script such as dev:cloud, dev:mock, or dev:local-backend.');
}
if (!['local', 'dev-server', 'remote'].includes(apiMode)) throw new Error(`Unsupported API mode: ${apiMode}`);

const modeLabels = {
  local: 'local Mock',
  'dev-server': 'local backend',
  remote: 'WeChat CloudRun',
};
console.log(`[build] API mode: ${modeLabels[apiMode]} (${apiMode})`);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

async function copyAssets() {
  const files = await walk(sourceDir);
  const assets = files.filter((file) => extname(file) !== '.ts');
  await Promise.all(
    assets.map(async (file) => {
      const destination = join(outputDir, relative(sourceDir, file));
      await mkdir(join(destination, '..'), { recursive: true });
      await cp(file, destination);
    }),
  );
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await copyAssets();

const typescriptFiles = (await walk(sourceDir)).filter((file) => extname(file) === '.ts');
const relativeSource = (file) => relative(sourceDir, file).replace(/\\/g, '/');
const excludedForRemote = new Set([
  'services/api.ts',
  'services/api-remote.ts',
  'services/local-api.ts',
  'services/database.ts',
  'services/remote-api.ts',
  'services/remote-client.ts',
  'services/dev-client.ts',
  'services/transport-client.ts',
]);
const excludedForLocal = new Set([
  'services/api.ts',
  'services/api-remote.ts',
  'services/remote-api.ts',
  'services/remote-client.ts',
  'services/dev-client.ts',
  'services/transport-client.ts',
]);
const excluded = apiMode === 'local' ? excludedForLocal : excludedForRemote;
const entryPoints = typescriptFiles
  .filter((file) => !excluded.has(relativeSource(file)))
  .map((file) => ({ in: file, out: relativeSource(file).replace(/\.ts$/, '') }));
const sharedOptions = {
  platform: 'neutral',
  format: 'cjs',
  target: 'es2020',
  sourcemap: apiMode !== 'remote',
  logLevel: 'info',
  define: {
    __API_MODE__: JSON.stringify(apiMode),
  },
};
const options = {
  ...sharedOptions,
  entryPoints,
  outbase: sourceDir,
  outdir: outputDir,
  bundle: false,
};
const apiOptions = {
  ...sharedOptions,
  entryPoints: [join(sourceDir, 'services', apiMode === 'local' ? 'api.ts' : 'api-remote.ts')],
  outfile: join(outputDir, 'services', 'api.js'),
  bundle: true,
  plugins: apiMode === 'local' ? [] : [{
    name: 'api-transport',
    setup(build) {
      build.onResolve({ filter: /^\.\/transport-client$/ }, () => ({
        path: join(sourceDir, 'services', apiMode === 'dev-server' ? 'dev-client.ts' : 'remote-client.ts'),
      }));
    },
  }],
};

if (watch) {
  const { context } = await import('esbuild');
  const [ctx, apiContext] = await Promise.all([context(options), context(apiOptions)]);
  await Promise.all([ctx.watch(), apiContext.watch()]);
  console.log('Watching src/ for changes...');
} else {
  await Promise.all([build(options), build(apiOptions)]);
}
