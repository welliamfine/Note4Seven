import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveEntries, createZip } from './lib/zip.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const node = process.execPath;
const commit = git(['rev-parse', 'HEAD']);
const shortCommit = commit.slice(0, 12);
const dirty = git(['status', '--porcelain']);
if (dirty) throw new Error('Release builds require a clean Git work tree. Commit or stash changes first.');
const suppliedRelease = argument('release-id');
const today = new Date().toISOString().slice(0, 10).replaceAll('-', '.');
const releaseId = suppliedRelease ?? `${today}-rc.2+${shortCommit}`;
if (!/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[a-z0-9.-]+\+[a-f0-9]{7,12}$/i.test(releaseId)) {
  throw new Error('Release ID must look like 2026.07.25-rc.2+<git-short-sha>.');
}
if (!releaseId.endsWith(`+${shortCommit}`) && !releaseId.endsWith(`+${shortCommit.slice(0, 7)}`)) {
  throw new Error(`Release ID must contain the current Git short SHA (${shortCommit}).`);
}

const output = join(root, 'artifacts', releaseId);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

run(node, ['scripts/scan-secrets.mjs'], root, 'secret scan');
run(npm, ['run', 'typecheck'], root, 'miniprogram typecheck');
run(npm, ['test'], root, 'miniprogram tests');
run(node, ['scripts/build.mjs', '--api-mode=remote', '--target-environment=production', `--release-id=${releaseId}`], root, 'miniprogram production build');
run(node, ['scripts/validate-project.mjs'], root, 'miniprogram static validation');
run(node, ['scripts/validate-production.mjs'], root, 'miniprogram production validation');
run(npm, ['run', 'verify'], join(root, 'server'), 'backend verification');
run(npm, ['run', 'verify'], join(root, 'cloudfunctions', 'cos-media-trigger'), 'COS trigger verification');

const units = [
  {
    name: 'miniprogram',
    root: join(root, 'dist'),
    files: await walk(join(root, 'dist')),
  },
  {
    name: 'backend',
    root: join(root, 'server'),
    files: await collectBackendSource(),
  },
  {
    name: 'cos-media-trigger',
    root: join(root, 'cloudfunctions', 'cos-media-trigger'),
    files: (await walk(join(root, 'cloudfunctions', 'cos-media-trigger')))
      .filter((file) => !file.includes(`${join('node_modules', '')}`) && !file.includes(`${join('coverage', '')}`)),
  },
];

const artifacts = [];
for (const unit of units) {
  const zipPath = join(output, `${unit.name}.zip`);
  const entries = archiveEntries(unit.files, unit.root);
  await writeFile(zipPath, await createZip(entries));
  const fileManifestPath = join(output, `${unit.name}.files.sha256`);
  const fileManifest = await checksumLines(unit.files, unit.root);
  await writeFile(fileManifestPath, `${fileManifest.join('\n')}\n`);
  artifacts.push(await artifactMetadata(zipPath, unit.name, entries.length));
}

for (const [name, directory] of [
  ['miniprogram', root],
  ['backend', join(root, 'server')],
  ['cos-media-trigger', join(root, 'cloudfunctions', 'cos-media-trigger')],
]) {
  const result = spawnSync(npm, ['sbom', '--omit=dev', '--sbom-format=cyclonedx'], {
    cwd: directory,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) throw new Error(`${name} SBOM failed: ${result.stderr}`);
  const sbomPath = join(output, `${name}.sbom.cdx.json`);
  await writeFile(sbomPath, result.stdout);
  artifacts.push(await artifactMetadata(sbomPath, `${name}-sbom`, null));
}

const migrations = await checksumLines(await walk(join(root, 'server', 'migrations')), join(root, 'server'));
const manifest = {
  schemaVersion: 1,
  releaseId,
  gitCommit: commit,
  gitTag: `release-${releaseId}`,
  createdAt: new Date().toISOString(),
  build: { node: process.version, npm: npmVersion(), platform: `${process.platform}-${process.arch}` },
  versions: { miniprogram: '0.3.0-rc.1', backend: '0.1.0', cosMediaTrigger: '1.0.0' },
  migrations,
  artifacts,
  deployment: { strategy: 'automatic-build-manual-approval', productionApproved: false },
  rollback: { targetReleaseId: argument('rollback-release-id') ?? 'TO_BE_SELECTED_BEFORE_DEPLOYMENT', databaseCompatibilityReviewed: false },
};
await writeFile(join(output, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(output, 'RELEASE_NOTES.md'), `# 发布记录 ${releaseId}

- Git commit：\`${commit}\`
- 构建时间：${manifest.createdAt}
- 迁移范围：${migrations.map((line) => `\`${line.split('  ')[1]}\``).join('、')}
- OpenAPI 合同：\`server/openapi/openapi.json\`
- 包体/性能：见 CI 产物与 staging 验收报告
- 部署人：待人工审批
- 验证人：待指定
- 回滚目标：${manifest.rollback.targetReleaseId}
- 已知风险：见 \`docs/operations/optimization-status.md\`

## 门禁

- [x] 三单元从锁文件对应源码构建
- [x] 单测、类型、构建、静态校验和依赖审计通过
- [x] SHA-256、文件清单和 SBOM 已生成
- [ ] 云配置取证与漂移检查通过
- [ ] staging 发布、真机验收与回滚演练通过
- [ ] 数据库备份、隔离恢复与迁移审批完成
- [ ] 监控告警演练通过
- [ ] 生产部署人工批准
- [ ] 发布后 30 分钟观察通过
`);
console.log(`[release] created ${releaseId} in ${output}`);

function argument(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function run(command, args, cwd, label) {
  console.log(`[release] ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'),
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}${result.error ? `: ${result.error.message}` : ''}`);
  }
}

function npmVersion() {
  const result = spawnSync(npm, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`Unable to read npm version: ${result.stderr || result.error?.message || 'unknown error'}`);
  return result.stdout.trim();
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

async function collectBackendSource() {
  const server = join(root, 'server');
  const files = [];
  for (const path of ['src', 'migrations', 'openapi']) files.push(...await walk(join(server, path)));
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'Dockerfile', '.dockerignore', '.env.example']) files.push(join(server, path));
  return files;
}

async function checksumLines(files, base) {
  const lines = [];
  for (const file of files.sort()) {
    const body = await readFile(file);
    lines.push(`${createHash('sha256').update(body).digest('hex')}  ${relative(base, file).replace(/\\/g, '/')}`);
  }
  return lines;
}

async function artifactMetadata(path, name, fileCount) {
  const body = await readFile(path);
  const metadata = await stat(path);
  return { name, file: relative(output, path).replace(/\\/g, '/'), bytes: metadata.size, fileCount, sha256: createHash('sha256').update(body).digest('hex') };
}
