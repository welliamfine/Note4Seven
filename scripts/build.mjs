import { build, transform } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceDir = join(root, 'src');
const outputDir = join(root, 'dist');
const packageManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');
const apiModeArgument = process.argv.find((argument) => argument.startsWith('--api-mode='));
const apiMode = apiModeArgument?.split('=')[1];
const targetArgument = process.argv.find((argument) => argument.startsWith('--target-environment='));
const targetEnvironment = targetArgument?.split('=')[1];
if (!apiMode) {
  throw new Error('Missing --api-mode. Use an explicit npm script such as dev:cloud, dev:mock, or dev:local-backend.');
}
if (!['local', 'dev-server', 'remote'].includes(apiMode)) throw new Error(`Unsupported API mode: ${apiMode}`);
if (!['development', 'staging', 'production'].includes(targetEnvironment)) {
  throw new Error('Missing or unsupported --target-environment. Use development, staging, or production.');
}

const environmentManifest = JSON.parse(await readFile(join(root, 'config', 'environments.json'), 'utf8'));
const environment = environmentManifest[targetEnvironment];
if (!environment) throw new Error(`No configuration for target environment: ${targetEnvironment}`);
if (apiMode === 'remote') {
  for (const key of ['appId', 'cloudEnvironmentId', 'cloudService', 'objectBucket', 'cosRegion', 'subscribeTemplateId']) {
    if (!environment[key] || String(environment[key]).startsWith('TO_BE_')) {
      throw new Error(`Remote ${targetEnvironment} build requires config/environments.json#${targetEnvironment}.${key}`);
    }
  }
}
if (apiMode === 'remote' && targetEnvironment !== 'development') {
  const otherEnvironmentName = targetEnvironment === 'staging' ? 'production' : 'staging';
  const otherEnvironment = environmentManifest[otherEnvironmentName];
  for (const key of ['cloudEnvironmentId', 'cloudService', 'objectBucket']) {
    const otherValue = otherEnvironment?.[key];
    if (environment[key] && otherValue && !String(otherValue).startsWith('TO_BE_') && environment[key] === otherValue) {
      throw new Error(`${targetEnvironment}.${key} must not reference the ${otherEnvironmentName} resource`);
    }
  }
}
let gitCommit = 'uncommitted';
try {
  gitCommit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} catch {
  // Source archives without Git metadata remain identifiable as uncommitted builds.
}
const releaseIdArgument = process.argv.find((argument) => argument.startsWith('--release-id='));
const releaseId = releaseIdArgument?.slice('--release-id='.length)
  || process.env.RELEASE_ID
  || `${packageManifest.version}+${gitCommit}`;

const modeLabels = {
  local: 'local Mock',
  'dev-server': 'local backend',
  remote: 'WeChat CloudRun',
};
console.log(`[build] API mode: ${modeLabels[apiMode]} (${apiMode}), environment: ${targetEnvironment}, release: ${releaseId}`);

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

const relativeSource = (file) => relative(sourceDir, file).replace(/\\/g, '/');

const minifyWxml = (source) => source.replace(/>\s+</g, '><').trim();

async function copyAssets() {
  const files = await walk(sourceDir);
  const assets = files.filter((file) => {
    if (extname(file) === '.ts') return false;
    const sourcePath = relativeSource(file);
    if (sourcePath.startsWith('mock-assets/')) return apiMode === 'local';
    return true;
  });
  await Promise.all(
    assets.map(async (file) => {
      const sourcePath = relativeSource(file);
      const outputPath = sourcePath.startsWith('mock-assets/stickers/')
        ? sourcePath.replace(/^mock-assets\//, 'assets/')
        : sourcePath;
      const destination = join(outputDir, outputPath);
      await mkdir(join(destination, '..'), { recursive: true });
      if (targetEnvironment !== 'development' && extname(file) === '.wxml') {
        const source = await readFile(file, 'utf8');
        await writeFile(destination, minifyWxml(source));
      } else if (targetEnvironment !== 'development' && extname(file) === '.wxss') {
        const source = await readFile(file, 'utf8');
        const result = await transform(source, { loader: 'css', minify: true, target: 'es2020' });
        await writeFile(destination, result.code);
      } else {
        await cp(file, destination);
      }
    }),
  );
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await copyAssets();

const typescriptFiles = (await walk(sourceDir)).filter((file) => extname(file) === '.ts' && !file.endsWith('.d.ts'));
const excludedForRemote = new Set([
  'services/api.ts',
  'services/api-remote.ts',
  'services/local-api.ts',
  'services/database.ts',
  'services/remote-api.ts',
  'services/remote-client.ts',
  'services/dev-client.ts',
  'services/transport-client.ts',
  'services/discovery-api.ts',
]);
const excludedForLocal = new Set([
  'services/api.ts',
  'services/api-remote.ts',
  'services/remote-api.ts',
  'services/remote-client.ts',
  'services/dev-client.ts',
  'services/transport-client.ts',
  'services/discovery-api.ts',
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
  minifyWhitespace: targetEnvironment !== 'development',
  minifySyntax: targetEnvironment !== 'development',
  logLevel: 'info',
  define: {
    __API_MODE__: JSON.stringify(apiMode),
    __TARGET_ENVIRONMENT__: JSON.stringify(targetEnvironment),
    __CLOUD_ENV_ID__: JSON.stringify(environment.cloudEnvironmentId),
    __CLOUD_SERVICE__: JSON.stringify(environment.cloudService),
    __SUBSCRIBE_TEMPLATE_ID__: JSON.stringify(environment.subscribeTemplateId),
    __RELEASE_ID__: JSON.stringify(releaseId),
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
  await writeFile(join(outputDir, 'build-meta.json'), `${JSON.stringify({
    schemaVersion: 1,
    apiMode,
    targetEnvironment,
    releaseId,
    gitCommit,
  }, null, 2)}\n`);
}
