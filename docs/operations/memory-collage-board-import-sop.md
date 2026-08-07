# 回忆拼贴新画板导入 SOP

## 1. 目的与适用范围

本 SOP 用于向回忆拼贴编辑器增量导入新画板。画板素材可以不同，但编辑坐标、拖拽逻辑、安全区、导出比例和保存协议必须一致。

本流程只接入真实远端素材目录和生产数据库记录，不为画板功能增加 mock 数据。正式环境只有在素材上传、增量迁移、真实接口检查和真机验收全部完成后才可开放新画板。

## 2. 不可变契约

| 项目 | 固定值或规则 |
|---|---|
| 源文件 | `1024 x 1024`、带透明通道的 PNG |
| 源画框 | `left=119, top=44, right=902, bottom=945`，单位为源图像素 |
| 编辑画布 | `1:1`，坐标均相对统一画布归一化到 `0..1` |
| 编辑安全区 | `left=0.045, top=0.13, right=0.955, bottom=0.945` |
| 原图对象键 | `memory-collage/boards/<asset-key>.webp` |
| 缩略图对象键 | `memory-collage/boards/<asset-key>-thumb.webp` |
| 稳定标识 | `asset_key` 创建后永不改名、永不复用、永不因排序重新编号 |
| 编辑行为 | 所有画板共用移动、缩放、旋转、层级、保存和导出逻辑 |

禁止为单张画板新增专属 `editableBounds`、专属拖拽容器或专属坐标换算。画板差异只能体现在底图文件、名称、分类和排序。

默认棕色画板是本地内置的默认展示素材。未保存作品最多预排八张记录贴纸；进入编辑器后，它与远端画板使用完全相同的安全区和手势逻辑。

## 3. 导入前准备

1. 从当前数据库和 `server/migrations` 确认下一个未使用的稳定 `asset_key`，例如 `board-08`。
2. 确认下一个迁移序号，迁移只能新增，不能修改已执行的迁移。
3. 将源文件放入 `design/board/`。建议文件名包含稳定键，例如 `board-08-source.png`。
4. 在设计工具中套用现有 1024 画板模板，确保主体位于统一源画框内。不要通过修改安全区补偿素材位置；应调整源图本身。

## 4. 生成资产与迁移

在仓库根目录执行：

```powershell
npm run collage:prepare-board -- --source=design/board/board-08-source.png --asset-key=board-08 --name=新画板名称 --category=default --sort-order=7 --migration=server/migrations/022_add_memory_collage_board_08.sql
```

脚本会执行以下门禁：

- 校验源文件位于 `design/board/`，迁移位于 `server/migrations/`；
- 校验 PNG、`1024 x 1024`、透明通道和统一源画框；
- 拒绝覆盖已存在的迁移文件；
- 固定写入统一编辑安全区；
- 在 `artifacts/memory-collage-board-import/<asset-key>/` 生成原图、缩略图和 `import-manifest.json`；
- 生成只包含该画板 upsert 的增量 SQL，不改历史迁移。

生成后检查 `import-manifest.json` 中的本地文件、COS 对象键和迁移路径是否一一对应。

## 5. 上传与数据库发布

1. 按 `import-manifest.json` 将原图和缩略图上传到当前发布目标的私有 COS，路径必须逐字符一致。
2. 在执行数据库迁移前，用具备只读权限的对象检查确认两个对象存在、Content-Type 正确且文件大小非零。
3. 运行 `npm --prefix server run migrations:write-manifest`，将新增迁移写入迁移清单。
4. 运行 `npm --prefix server run migrations:check` 和 `npm --prefix server run verify`。
5. 按项目发布流程部署后端并执行真实数据库迁移。不要手工改生产表，也不要跳过迁移清单。
6. 通过真实 `/api/v1/views/memories/collage` 响应确认新画板出现，签名 URL 可访问，且 `editableBounds` 为统一固定值。

发布顺序必须是“先上传对象，再迁移数据库”。这样接口不会返回尚不存在的底图路径。

## 6. 编辑器与真机验收

至少在一台 iOS 和一台 Android 真机上检查：

1. 未保存作品首次进入时，默认棕色画板展示最多八张整齐预排的记录贴纸。
2. 默认棕色画板与新画板之间来回切换，贴纸的 `x/y/width/height/rotation/zIndex` 不发生变化。
3. 在每张画板上分别把同一贴纸拖到左、上、右、下四个安全边缘，四张画板的可达位置一致。
4. 在右下边缘完成缩放和旋转，贴纸不会跳回、截断或越过统一安全区。
5. 保存后退出再进入，画板、位置、尺寸、角度和层级完全还原。
6. 回忆页预览与编辑器画面一致；导出 PNG 与编辑器一致。
7. 周报和月报、全部模块和单模块各完成一次真实保存与读取。

自动化门禁：

```powershell
npm run typecheck
npm run lint
npx vitest run tests/memory-collage.test.ts tests/memory-collage-assets.test.ts tests/remote-memory-collage.test.ts
npm run build:production
node scripts/validate-project.mjs
node scripts/validate-production.mjs
```

## 7. 回滚

1. 数据库新增一条只将目标 `asset_key` 的 `status` 更新为 `retired` 的回滚迁移，不删除记录。
2. 保留已被作品引用的 COS 原图和缩略图，避免历史作品失效。
3. 重新验证画板目录不再向新作品展示该画板，已有作品仍能正常渲染。
4. 只有确认数据库不存在任何引用后，才可按对象存储清理流程删除文件。

禁止复用已下架画板的 `asset_key` 指向另一张图片。

## 8. 代码维护检查

每次修改画板编辑逻辑时，必须确认以下事实仍成立：

- `src/utils/memory-collage.ts` 是安全区和可移动区域样式的唯一前端来源；
- `src/subpackages/memory-collage-editor/index.ts` 会对本地默认画板和远端画板执行同一安全区归一化；
- `scripts/prepare-memory-collage-board.mjs` 和全量素材生成器写入相同安全区；
- 切换画板只切换底图，不重新排版或夹紧到另一套边界；
- 边界回归测试覆盖最右和最下可达位置。
