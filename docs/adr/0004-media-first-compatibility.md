# ADR 0004: 保留 media-first 与 pending-record-first 兼容

状态：Accepted，2026-07-25。

新客户端优先创建媒体预留、上传并等待 ready，再提交记录，以减少半完成记录。但在最低在线客户端版本越过兼容窗口、staging 完成旧版回放且生产指标证明无调用前，后端继续接受 pending-record-first 路径。

两条路径共用幂等键、媒体/记录状态机和服务端事实。删除兼容接口属于破坏性变更，需独立 ADR、版本数据和回滚计划。
