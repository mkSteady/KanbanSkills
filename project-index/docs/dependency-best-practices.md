# 依赖分析最佳实践

依赖分析的目标是：在代码变更后，用最小成本回答「影响范围」与「修复优先级」。

工具链（建议按顺序使用）：

```
dependency-graph.js → impact-analyzer.js → stale-propagate.js → test-affected.js → test-prioritize.js → test-fix.js
```

> 说明：本文示例命令默认在 `scripts/` 目录执行；在项目根目录执行时请加 `scripts/` 前缀（如 `node scripts/impact-analyzer.js ...`）。

## 依赖图构建

- **何时构建依赖图**
  - **项目初始化**：首次接入项目、新增模块边界、或大规模目录调整后
  - **代码变更后**：新增/删除/移动文件、修改 `import/require`、重构模块依赖关系后
- **依赖图存储**：依赖图输出到 `.dep-graph.json`（由脚本生成，属于派生数据）
- **依赖关系类型**
  - `import/export`（ESM 静态依赖）
  - `require()`（CommonJS 依赖）
  - 动态导入 `import()`（可能是 best-effort，建议配合 impact 深度控制）

## 影响分析（impact-analyzer.js）

- **分析变更文件的下游影响**：基于 `.dep-graph.json` 沿依赖边向下游扩散，输出受影响文件集合（常用 L1/L2 分层）
- **使用场景**
  - 代码审查前评估影响范围
  - 测试优先级排序
  - 重构风险评估

| 场景 | 命令 | 说明 |
|------|------|------|
| 分析指定文件 | `node impact-analyzer.js file1.js file2.js` | 直接指定文件 |
| 分析 git 变更 | `node impact-analyzer.js --since HEAD~5` | 分析最近 5 次提交 |
| 分析暂存区 | `node impact-analyzer.js --staged` | 分析 git staged 文件 |

## Stale 传播（stale-propagate.js）

- 将 stale 状态沿依赖图向下游传播
- 传播深度控制（默认 2 层）
- 生成测试重跑列表

### 工作流程

1. 检测直接 stale 文件（源码修改但文档/测试未更新）
2. 沿依赖图传播 stale 状态到下游
3. 生成受影响的测试列表
4. 按优先级排序

## 测试优先级（test-prioritize.js）

- 智能排序修复顺序：root cause 优先 + 并行批次
- 使用 DAG 分析依赖关系
- 输出三阶段修复计划：
  - Phase 1: Root causes（被依赖最多的文件）
  - Phase 2: Independent（可并行修复的批次）
  - Phase 3: Leaf nodes（依赖链末端）

### 典型场景：100+ 测试失败

```bash
# 1. 分析优先级
node test-prioritize.js --from-file test-results.json

# 输出示例：
# Phase 1 - Root causes: shared/utils/logger.js (261 依赖)
# Phase 2 - Independent: 可并行修复的批次
# Phase 3 - Leaf nodes: 最后修复

# 2. 按优先级修复
# 先修 root cause（一个修复解决多个错误）
# 再并行修独立集（60 开并发）
# 最后修叶子节点
```

## 典型工作流

### 代码修改后的完整流程

```bash
# 1. 构建/更新依赖图
node dependency-graph.js --module js/agents

# 2. 分析影响范围
node impact-analyzer.js --staged

# 3. 检查 stale 传播
node stale-propagate.js --tests

# 4. 运行受影响的测试
node test-affected.js --staged

# 5. 如果有失败，分析优先级
node test-prioritize.js --from-file test-results.json

# 6. 按优先级修复
# 复制 test-prioritize 输出的建议命令（Phase 1 → Phase 2 → Phase 3）
node test-fix.js <root-cause-file1> <root-cause-file2>
```

## 硬约束规则（MUST/MUST NOT）

### MUST

- ✅ 代码修改后必须更新依赖图
- ✅ 大规模重构前必须运行影响分析
- ✅ 测试修复必须按优先级排序（root cause 优先）
- ✅ stale 传播深度不超过 3 层（避免过度传播）

### MUST NOT

- ❌ 不得跳过依赖图构建直接运行影响分析
- ❌ 不得忽略 stale 传播结果直接修复测试
- ❌ 不得在有 root cause 未修复时并行修复叶子节点
- ❌ 不得手动编辑 `.dep-graph.json`（应通过脚本生成）

## 与 test-fix 整合

当前 `test-fix.js` 不使用 DAG 调度，建议整合：

### 现状

- test-fix.js → BatchRunner 并发池，不管依赖顺序
- test-prioritize.js → DAG 分析，输出优先级排序（并在 human 输出中给出可直接执行的 `test-fix` 命令）

### 建议整合方案

> 以下为建议方案，需要先实现对应参数（如 `--from-file` / `--prioritized` / `--dag`）。

```bash
# 方案 1：先分析后修复（两步）
node test-prioritize.js --from-file test-results.json > priority.txt
node test-fix.js --from-file priority.txt

# 方案 2：test-fix 内置 DAG 调度（一步）
node test-fix.js --prioritized --dag
```

## 性能优化

| 操作 | 建议 | 说明 |
|------|------|------|
| 依赖图构建 | 增量更新 | 只重新分析变更文件 |
| 影响分析 | 限制深度 | 默认 2-3 层，避免全图遍历 |
| stale 传播 | 批量处理 | 一次传播多个 stale 文件 |
| 测试优先级 | 缓存结果 | 相同变更集复用分析结果 |

参考 [dag-scheduling.md](dag-scheduling.md) 的拓扑排序算法。  
参考 [testing.md](testing.md) 的测试工具链。
