# 代码审计最佳实践

面向 `AUDIT.md` 的生成、修复、归档与 Kanban 集成的实践指南（适用于 `code-audit.js` / `module-analyzer.js` / `audit-fix.js` / `audit-archive.js`）。

## 审计流程概述

### 何时触发审计

- **代码修改后**：修改模块代码后，必须检查并更新对应的 `AUDIT.md`（无新增问题也要 `touch` 更新时间戳）。
- **定期审计**：建议按周/双周对核心目录做一次全量审计，集中处理技术债与历史遗留风险。
- **发布前**：发布/上线前对变更范围做一次审计（至少覆盖高风险模块与变更热点）。

### 审计范围

- **模块级**：以目录为单元生成/维护 `AUDIT.md`，便于和 `check-stale.js`、Kanban、Dashboard 统一追踪。
- **文件级**：针对单个文件/小范围 diff 做精细审计，输出仍应回流到模块级 `AUDIT.md`（避免“散落的审计结论”）。

### 审计输出（AUDIT.md 格式）

推荐使用“可机器解析”的结构（`audit-archive.js` / `module-analyzer.js` 兼容）：

````markdown
# Security Audit - <module-path>

Generated: <ISO-8601>
Severity: **HIGH**

## Summary
一句话结论 + 风险边界 + 建议优先级。

## Issues (2)
### 1. <issue-type-or-title>
- **File**: path/to/file.js:123
- **Description**: 问题描述（可复现、可定位）
- **Suggestion**: 修复建议（可执行步骤）
```javascript
// 可选：放 10–30 行“最相关的”上下文（避免整文件粘贴）
```
````

> 需要自动修复（`audit-fix.js`）时，请额外确认 Issue 头部格式兼容（见“修复流程”一节）。

## 审计问题分类与优先级

| 优先级 | 类型 | 说明 | 示例 |
|--------|------|------|------|
| P0 | 安全漏洞 | 立即修复 | SQL 注入、XSS |
| P1 | 逻辑错误 | 影响功能 | 空指针、死循环 |
| P2 | 代码质量 | 技术债务 | 重复代码、命名不规范 |

## 修复流程（audit-fix.js）

`audit-fix.js` 用于**并发**对可自动修复的问题生成补丁并落盘，同时输出 Dashboard 可读的任务状态文件。

### 流程

1. **读取 `AUDIT.md`**：解析 Issues，识别严重级别、文件位置、上下文与建议。
2. **筛选可修复项**：只对“可自动修复的类型 + 非 CRITICAL”尝试生成修复。
3. **并发修复（LLM）**：按 `--concurrency` 分批并发调用 LLM 生成 JSON 补丁。
4. **应用补丁**：将变更写回源码文件。
5. **更新审计状态**
   - 将已修复项写入模块内的 `AUDIT_HISTORY.md`（含修复方式：`Auto-fixed by audit-fix`）。
   - 从 `AUDIT.md` 中移除对应 issue block。
6. **验证修复结果**：运行项目测试/静态检查，确认无回归（脚本不会替你自动跑测试）。

### 常用命令

```bash
# 扫描并修复（默认并发 3）
node scripts/audit-fix.js

# 预览模式（不落盘）
node scripts/audit-fix.js --dry-run

# 限定严重级别 / 模块 / 并发数
node scripts/audit-fix.js --severity=LOW --module=js/agents/core --concurrency=6

# 查看上次结果（JSON）
node scripts/audit-fix.js --status
```

### Checkpoint（任务状态文件）

`audit-fix.js` 会写入以下文件用于进度追踪：

```
.project-index/
├── .audit-fix-tasks.json    # per-issue 状态（pending/completed/failed）
└── .audit-fix-result.json   # 汇总统计 + 运行耗时
```

### ❗AUDIT.md 格式要求（audit-fix）

当前 `audit-fix.js` 的解析器期望 issue 头部形如：

```markdown
### [LOW] Add JSDoc for foo
- **File**: src/foo.js:12
- **Description**: ...
- **Suggestion**: ...
```

如果你的 `AUDIT.md` 由 `module-analyzer.js` 生成（`### 1. <type>` 这种编号格式），建议：

- ✅ 使用 `audit-archive.js` 做归档清理（保持编号结构一致）
- ✅ 或在需要自动修复的 issue 上补齐 `[SEVERITY]` 头部格式后再运行 `audit-fix.js`

## 归档流程（audit-archive.js）

`audit-archive.js` 用于把**已修复**的问题从 `AUDIT.md` 迁移到 `AUDIT_HISTORY.md`，并保持 `AUDIT.md` 的 Issues 列表干净可读。

### 流程

1. 解析 `AUDIT.md`（Severity / Summary / Issues）。
2. 选择要归档的 issue（指定编号或 `--all`）。
3. 追加到 `AUDIT_HISTORY.md`（保留归档日期与原 issue 内容）。
4. 从 `AUDIT.md` 移除已归档项；若 Issues 清空则：
   - `Severity` 自动置为 `NONE`
   - `## Issues (0)` 下写入 “No current issues … archived …”

### 常用命令

```bash
# 查看当前 issues
node scripts/audit-archive.js <module-path> --show

# 归档指定 issue 编号
node scripts/audit-archive.js <module-path> 1 3 5

# 归档全部 issues
node scripts/audit-archive.js <module-path> --all

# 查看历史归档
node scripts/audit-archive.js <module-path> --history
```

### 归档信息必须包含“修复方式”

`audit-archive.js` 会把 issue 的原内容原样写入 `AUDIT_HISTORY.md`。最佳实践是：在归档前在 issue 内容里补一行修复方式（确保历史可追溯）：

```markdown
- **Resolution**: Manual fix / Refactor / Auto-fixed by audit-fix / PR#123
```

## 常见审计问题类型和修复模式

### 安全问题

- ❌ 硬编码密钥（token/API key/password）
- ✅ 使用环境变量或 Secret Manager（并在 README/部署系统中说明）
- ❌ 未验证用户输入（参数直传 DB/HTML/命令）
- ✅ 输入校验 + 规范化 + 清理（白名单优先）

示例（环境变量）：

```javascript
// ❌ hardcoded
const apiKey = 'sk-xxx';

// ✅ env var
const apiKey = process.env.API_KEY;
if (!apiKey) throw new Error('Missing API_KEY');
```

### 代码质量

- ❌ 重复代码（DRY 违反）
- ✅ 提取公共函数/模块，收敛入口
- ❌ 过长函数（> 50 行）+ 多重分支嵌套
- ✅ 拆分为小函数，按“单一职责”组织（每个函数可单测）

示例（提取公共逻辑）：

```javascript
// ✅ 提取公共函数，避免复制粘贴
export function normalizePath(input) {
  return String(input).replace(/\\/g, '/').replace(/\/+$/, '');
}
```

## 与 Kanban 集成

### 自动创建任务

当 `features.kanban=true` 且 Kanban 服务可用时，`module-analyzer.js` 会为每个审计 issue 创建一个任务（标题带 `[AUDIT/<SEVERITY>]` 前缀，tag 包含 `audit` + `severity` + `type`）。

```bash
export KANBAN_URL=http://127.0.0.1:3007/api/v1
```

### 优先级映射

建议把审计优先级映射到 Kanban 优先级（便于排期）：

| 审计优先级 | 建议 Kanban Priority | 说明 |
|-----------|-----------------------|------|
| P0 | urgent（≈ 0） | 立即处理 |
| P1 | high（≈ 1） | 本迭代处理 |
| P2 | normal（≈ 2） | 计划内处理 |

> 实现侧通常会用数字优先级（例如 `critical=0, high=1, medium=2, low=3`），以 Kanban 实际约定为准。

### 任务状态同步

目前“创建任务”与“修复完成”之间往往需要人为闭环。推荐流程：

1. 修复代码并验证（测试通过）。
2. 使用 `audit-archive.js` 将对应 issue 归档。
3. 将 Kanban 任务状态从 `todo` → `done`（或 `in_progress` → `done`），并在任务描述中补充：
   - 归档日期（`Archived: YYYY-MM-DD`）
   - 修复方式/commit/PR 链接

## 硬约束规则（MUST/MUST NOT）

### MUST

- ✅ 修复前必须读取完整的 `AUDIT.md`
- ✅ 只修改 `AUDIT.md` 中列出的文件（不“顺手重构”无关内容）
- ✅ 修复后必须验证（运行测试/静态检查）
- ✅ 归档时必须记录修复方式（写入 `AUDIT_HISTORY.md` 可追溯）

### MUST NOT

- ❌ 不得修改 `AUDIT.md` 未列出的文件
- ❌ 不得跳过验证步骤
- ❌ 不得删除 `AUDIT.md` 中的问题（应归档而不是直接抹掉历史）
- ❌ 不得在并发修复时执行 Git 操作（详见 [anti-patterns.md](anti-patterns.md) 的 CRITICAL 约束）

## 批量修复最佳实践

参考 [batch-best-practices.md](batch-best-practices.md) 的并发设置与 checkpoint/resume 章节。

### 并发建议

- 审计分析/生成：**20–30**（需要上下文分析，属于“中等强度”任务）
- 自动修复落盘：从 **3–8** 起步，观察 rate limit 与补丁冲突后再提高

### Checkpoint / Resume

- ✅ BatchRunner 类任务优先使用 `--resume` / `--retry-failed`（如 `module-analyzer.js` / `test-fix.js` / `test-generator.js`）
- ✅ 任何脚本中断后先看 `.project-index/` 下的 `*-tasks.json` / `*-result.json` 再决定重跑策略

### 失败重试策略

- ✅ 优先使用指数退避（5s → 10s → 20s），最多 3 次
- ✅ rate limit 频繁时：降低并发、缩小范围（按模块/按严重级别分批）

示例（BatchRunner 重试参数）：

```javascript
const runner = new BatchRunner({
  maxRetries: 3,
  retryDelay: 5000
});
```

### 进度监控

```bash
# Web Dashboard（任务状态 / 分组 / 重试）
node scripts/dashboard.js --open
```
