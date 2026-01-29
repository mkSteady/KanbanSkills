# 批量任务最佳实践

BatchRunner 批量 LLM 任务执行的经验总结。

## 并发设置

| 任务类型 | 建议并发数 | 说明 |
|----------|------------|------|
| 文档生成 | 30-40 | I/O 密集，可设高 |
| 代码审计 | 20-30 | 需要分析上下文 |
| 测试修复 | 40-60 | 每个任务独立 |
| 测试生成 | 10-20 | 生成量大，token 消耗高 |

```bash
# 高并发
node module-analyzer.js --concurrency=40

# 保守设置（API 限制时）
node module-analyzer.js --concurrency=10
```

## Checkpoint 和 Resume

### 自动保存

BatchRunner 在每个任务完成后自动保存进度：

```
.project-index/
├── .module-analyzer-tasks.json   # 任务状态
├── .module-analyzer-progress.json # 进度
└── .module-analyzer-result.json   # 最终结果
```

### 中断恢复

```bash
# 任务中断后恢复
node module-analyzer.js --resume

# 只重试失败的任务
node module-analyzer.js --retry-failed
```

### 查看状态

```bash
node module-analyzer.js --status
```

## Daemon 模式

长时间任务建议后台运行：

```bash
# 启动后台任务
node module-analyzer.js --daemon --concurrency=40

# 查看进度
tail -f .project-index/.module-analyzer.log

# 查看结果
node module-analyzer.js --status
```

## Rate Limit 处理

BatchRunner 自动处理 429 错误：

1. 指数退避重试（5s → 10s → 20s）
2. 最多重试 3 次
3. 失败后记录到 failedList

```javascript
const runner = new BatchRunner({
  maxRetries: 3,      // 重试次数
  retryDelay: 5000    // 基础延迟
});
```

## 错误恢复策略

### 部分失败

```bash
# 查看失败任务
node module-analyzer.js --status | jq '.failedList'

# 重试失败
node module-analyzer.js --retry-failed
```

### 完全重跑

```bash
# 清除进度文件后重跑
rm .project-index/.module-analyzer-*.json
node module-analyzer.js --force
```

## 分批处理

大量任务时分批：

```bash
# 只处理 stale
node module-analyzer.js --stale

# 只处理 missing
node module-analyzer.js --missing

# 限定范围
node module-analyzer.js js/agents/core
```

## 进度监控

### 实时日志

```bash
tail -f .project-index/.module-analyzer.log
```

### Dashboard

```bash
node scripts/dashboard.js --open
# 访问 http://localhost:3008
```

## DAG 依赖调度

处理有依赖关系的任务（如目录层级）：

```javascript
scan: async () => modules.map(m => ({
  id: m.path,
  dependencies: getChildModules(m.path),  // 子目录先完成
  ...
}))
```

详见 [dag-scheduling.md](dag-scheduling.md)

## 安全约束

所有 LLM prompt 必须加入安全前缀：

```javascript
import { SAFETY_PROMPT_PREFIX } from './shared.js';

buildPrompt: async (item) => {
  return SAFETY_PROMPT_PREFIX + actualPrompt;
}
```

详见 [anti-patterns.md](anti-patterns.md#7-llm-prompt-安全约束)

## 常见问题

### Q: 任务卡住不动？

检查 API 状态或网络。查看日志：
```bash
tail -20 .project-index/.module-analyzer.log
```

### Q: 并发数设多高合适？

从 20 开始，观察 rate limit 错误频率。无错误可逐步提高到 40-60。

### Q: Resume 后任务重复执行？

检查 `.project-index/.module-analyzer-tasks.json` 中的 status 字段。
