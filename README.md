# Claude Code Skills

本仓库存放自定义 Claude Code Skills，通过 symlink 同步到 `~/.claude/skills/`。

## 快速开始

```bash
# 克隆仓库
git clone <repo-url> ~/skills

# 创建 symlinks
ln -s ~/skills/project-index ~/.claude/skills/project-index
ln -s ~/skills/kanban ~/.claude/skills/kanban
ln -s ~/skills/kanban/batch ~/.claude/skills/kanban-batch
ln -s ~/skills/kanban/implement ~/.claude/skills/kanban-implement
```

## Skills 列表

| Skill | 描述 | 前置依赖 |
|-------|------|----------|
| **project-index** | CLAUDE.md/AUDIT.md 索引管理、过期检测、代码审计、Dashboard | codeagent-wrapper |
| **kanban** | 本地 Kanban 任务管理 | CodeKanban 服务 |
| **kanban-batch** | 批量任务并行执行 | CodeKanban 服务 |
| **kanban-implement** | 任务开发工作流 (Worktree) | CodeKanban 服务 |

---

## 前置依赖

### 1. codeagent-wrapper

多后端 LLM 调用封装，用于批量代码分析任务。

```bash
# 安装 myclaude skills
# https://github.com/cexll/myclaude
```

**支持的后端：** `codex` (默认) | `claude` | `gemini`

### 2. CodeKanban 服务 (可选)

本地任务管理服务，提供 REST API。

```bash
npx codekanban              # 快速运行
codekanban --port 3007      # 指定端口
```

---

## 目录结构

```
skills/
├── README.md
├── data/                       # 共享数据
├── project-index/              # CLAUDE.md 索引系统
│   ├── SKILL.md
│   ├── pages/                  # Dashboard Web UI
│   │   ├── dashboard.html      # 前端页面
│   │   ├── dashboard.js        # 前端逻辑
│   │   ├── dashboard.css       # 样式
│   │   └── start.sh            # 启动脚本
│   ├── scripts/
│   │   ├── dashboard.js        # Dashboard 服务端 (端口 3008)
│   │   ├── batch-llm-runner.js # 批量 LLM 框架 (429重试/自动续传)
│   │   ├── module-analyzer.js  # 文档更新 + 代码审计
│   │   ├── check-stale.js      # 过期检测 (--type 参数)
│   │   ├── audit-status.js     # 审计状态 API
│   │   ├── test-status.js      # 测试状态 API
│   │   ├── test-analyzer.js    # 测试覆盖率分析
│   │   ├── stale-notify.js     # SessionStart Hook
│   │   ├── hook.js             # Hook 管理器
│   │   └── shared.js           # 共享工具函数
│   └── docs/
└── kanban/                     # 本地 Kanban
    ├── SKILL.md
    ├── kanban-cli.js
    ├── batch/                  # kanban-batch
    └── implement/              # kanban-implement
```

---

## project-index

管理大型项目的分层文档索引系统。

### Dashboard Web UI

启动 Dashboard 服务：

```bash
node ~/.claude/skills/project-index/scripts/dashboard.js
# 访问 http://localhost:3008
```

**四大功能区：**

| 功能区 | 说明 |
|--------|------|
| **任务启动器** | 预设工具卡片 (文档索引/代码审计/测试分析)，可视化参数配置 |
| **运维中心** | 任务列表、细粒度子任务、单任务重试、成功率统计、ETA 预测 |
| **项目洞察** | 审计问题分类、测试通过率、文档覆盖率、Stale 情况统计 |
| **配置面板** | 可视化编辑 .stale-config.json，敏感级别切换，JSON 校验 |

### CLI 命令

| 脚本 | 说明 |
|------|------|
| `hook.js init` | 初始化项目 (安装 hooks + 创建配置) |
| `hook.js install <hook>` | 安装特定 hook |
| `check-stale.js` | 检查过期模块 |
| `check-stale.js --type=claude` | 只检测 CLAUDE.md (默认) |
| `check-stale.js --type=audit` | 只检测 AUDIT.md |
| `check-stale.js --type=all` | 同时检测两种文档 |
| `check-stale.js --json` | JSON 格式输出 |
| `check-stale.js --touch-all` | 标记所有为最新 |
| `module-analyzer.js` | 运行分析 (前台) |
| `module-analyzer.js --daemon` | 后台运行 |
| `module-analyzer.js --all` | 全量重建索引 |
| `module-analyzer.js --concurrency=15` | 指定并发数 |
| `module-analyzer.js --status` | 查看上次结果 |

### batch-llm-runner.js 特性

- **429 自动重试**：检测 Rate Limit 错误，指数退避 (5s→10s→20s)
- **自动断点续传**：检测 checkpoint 文件，无需 `--resume` 参数
- **高并发支持**：最高并发 15，worker pool 模式

### Dashboard API 端点

| 端点 | 说明 |
|------|------|
| `GET /api/projects` | 项目列表 |
| `GET /api/project-data/:path` | 模块数据 |
| `GET /api/tasks` | 任务列表 |
| `GET /api/task-details/:name` | 细粒度子任务 |
| `GET /api/audit-status` | 审计状态 (按严重级别分类) |
| `GET /api/test-status` | 测试状态 |
| `GET /api/stale-status` | Stale 检测结果 |
| `GET /api/eta` | ETA 预测 |
| `GET /api/cached-data` | 缓存数据 (快速启动) |
| `POST /api/start-task` | 启动任务 |
| `POST /api/retry-task` | 重试单个子任务 |
| `POST /api/save-config` | 保存配置 |

### 配置文件 `.stale-config.json`

```json
{
  "include": ["js/**"],
  "ignore": ["tests/**", "docs/**", "*.test.js"],
  "features": {
    "doc": true,
    "audit": true,
    "kanban": true,
    "testAnalysis": true
  },
  "notify": {
    "enabled": true,
    "threshold": 3,
    "onSessionStart": true
  },
  "testing": {
    "coverage": {
      "target": 90,
      "minimum": 80
    }
  },
  "security": {
    "severity": ["critical", "high", "medium", "low"]
  },
  "timeout": 1800000,
  "concurrency": 15
}
```

---

## kanban

本地 Kanban 任务管理，替代 GitHub Issues，私有数据不暴露。

**Slash 命令：**

| 命令 | 说明 |
|------|------|
| `/kanban` | 显示当前项目状态 |
| `/kanban list` | 列出所有任务 |
| `/kanban add <title>` | 创建新任务 |
| `/kanban done <id>` | 标记任务完成 |
| `/kanban start <id>` | 开始任务 |
| `/kanban worktree <id>` | 为任务创建 worktree |
| `/kanban export` | 导出任务上下文 |

---

## kanban-batch

批量并行执行 Kanban 任务，自动分析依赖关系。

| 命令 | 说明 |
|------|------|
| `/kanban-batch` | 处理所有 todo 任务 |
| `/kanban-batch --priority=0` | 只处理 P0 任务 |
| `/kanban-batch --dry-run` | 只生成计划 |
| `/kanban-batch --max=5` | 最多并行 5 个 |

---

## kanban-implement

任务开发工作流，支持 Git Worktree 隔离开发。

| 命令 | 说明 |
|------|------|
| `/kanban-implement <task-id>` | 实现指定任务 |
| `/kanban-implement <task-id> --no-worktree` | 在当前分支开发 |

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KANBAN_URL` | `http://127.0.0.1:3005` | Kanban API 地址 |
| `DASHBOARD_PORT` | `3008` | Dashboard 服务端口 |

---

## 开发

### 添加新 Skill

1. 在 `skills/` 下创建目录
2. 添加 `SKILL.md` (必需)
3. 添加辅助脚本/模板
4. 创建 symlink 到 `~/.claude/skills/`

### 测试

```bash
# Dashboard
node ~/.claude/skills/project-index/scripts/dashboard.js

# 检测过期
node ~/.claude/skills/project-index/scripts/check-stale.js --type=all --json

# Kanban CLI
node ~/.claude/skills/kanban/kanban-cli.js status
```

---

## 致谢

| 组件 | 来源 | 许可证 |
|------|------|--------|
| **codeagent-wrapper** | [cexll/myclaude](https://github.com/cexll/myclaude) | AGPL-3.0 |
| **CodeKanban** | [fy0/CodeKanban](https://github.com/fy0/CodeKanban) | Apache-2.0 |

---

## 许可证

Apache-2.0
