# ADR 0005: 同进程 Runner 与 MySQL 任务队列

状态：Accepted，2026-07-25。

当前规模下，API 与 Runner 同进程，MySQL 保存 Outbox、调度锁、重试与死信事实。这避免在无容量证据时引入 Redis/Kafka 和独立 Worker 运维面。

必要保护包括租约心跳、幂等状态转移、有界重试、死信、积压指标和优雅停机。当任务年龄连续 15 分钟超过 5 分钟，或 API/Runner CPU 明确互相挤压，再基于压测和成本评审独立 Worker。
