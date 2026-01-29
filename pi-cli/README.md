# pi-cli v2.1

统一的项目分析与维护工具，支持 DAG 调度、LLM 批量任务、依赖图分析、测试修复、文档生成、代码审计。

## 特性

- **通用化设计**：支持 JS/TS/Python/Go/Rust 等多语言
- **配置驱动**：`.pi-config.json` + `.stale-config.json` 双配置
- **DAG 调度**：依赖感知的并发执行，子目录先于父目录
- **LLM 批量**：codeagent-wrapper 集成，并发 + 重试 + checkpoint
- **统一 CLI**：`pi <command> [subcommand]`
- **Web Dashboard**：SSE 实时更新，任务管理，配置编辑

## 快速开始

```bash
# 1. 初始化配置
pi init

# 2. 构建依赖图
pi deps build

# 3. LLM 驱动的模块分析（生成 CLAUDE.md + AUDIT.md）
pi module analyze --llm --concurrency=20

# 4. 测试分析和修复
pi test map
pi test fix --llm --concurrency=10

# 5. 启动 Dashboard
pi ui --port=3008
```

## 命令

| 命令 | 子命令 | 说明 |
|------|--------|------|
| `init` | - | 初始化 .pi-config.json |
| `deps` | build, impact, propagate, query | 依赖图分析 |
| `test` | map, run, plan, fix, affected, prioritize, generate | 测试操作 |
| `doc` | generate, check, scan | 文档生成 |
| `audit` | scan, fix, status, archive | 代码审计 |
| `module` | analyze | LLM 模块分析 |
| `task` | list, start, cancel, types | 任务管理 |
| `stale` | notify, status | Stale 通知 |
| `update` | - | 增量更新 |
| `hook` | init, install, uninstall | Claude Code hooks |
| `ui` | - | Web Dashboard |

## LLM 模式

通过 `--llm` 启用 LLM 驱动的智能分析：

```bash
# 模块分析（含 Kanban 集成）
KANBAN_URL=http://localhost:3007/api/v1 pi module analyze --llm

# 测试修复（安全约束：只改测试，不改实现）
pi test fix --llm --concurrency=20
```

## DAG 调度

任务带 `dependencies` 字段时自动启用 DAG 调度：

```javascript
const tasks = [
  { id: 'parent', dependencies: ['child1', 'child2'], prompt: '...' },
  { id: 'child1', prompt: '...' },
  { id: 'child2', prompt: '...' }
];
// child1, child2 并发执行，完成后 parent 才开始
```

## 配置文件

### .pi-config.json

```json
{
  "name": "my-project",
  "language": "javascript",
  "src": {
    "dirs": ["src"],
    "pattern": "**/*.js",
    "ignore": ["node_modules", "dist"]
  },
  "test": {
    "dirs": ["tests"],
    "pattern": "**/*.test.js",
    "cmd": "npm test",
    "framework": "vitest"
  },
  "cache": ".project-index",
  "llm": {
    "provider": "codex",
    "timeout": 600000
  }
}
```

## 目录结构

```
pi-cli/
├── cli.js              # 统一入口
├── lib/
│   ├── shared.js       # 工具函数
│   ├── context.js      # 配置加载
│   ├── types.js        # 类型定义
│   ├── deps/           # 依赖图分析
│   │   └── graph.js    # 依赖图 + 影响分析
│   ├── test/           # 测试操作
│   │   ├── mapper.js   # 源码↔测试映射
│   │   ├── runner.js   # 测试运行
│   │   ├── prioritize.js # 优先级排序
│   │   ├── fix.js      # LLM 测试修复
│   │   └── generator.js # 测试生成
│   ├── doc/            # 文档生成
│   │   └── generate.js # CLAUDE.md 生成 + stale 检测
│   ├── audit/          # 代码审计
│   │   └── scan.js     # AUDIT.md 生成
│   ├── module/         # LLM 模块分析
│   │   └── analyzer.js # 批量文档/审计生成
│   ├── llm/            # LLM 批量执行
│   │   └── batch.js    # DAG 调度 + codeagent-wrapper
│   ├── task/           # 任务管理
│   │   └── manager.js  # PID 跟踪 + 状态管理
│   ├── stale/          # Stale 通知
│   └── update/         # 增量更新
└── ui/
    └── server.js       # Dashboard (SSE + API)
```

## Dashboard

访问 `http://localhost:3008`，功能包括：

- **总览**：过期状态、缓存来源
- **模块**：模块列表、过滤、状态筛选
- **任务**：启动/取消/删除/重试任务
- **依赖图**：D3 可视化
- **配置**：编辑 .stale-config.json
- **启动**：任务类型选择、参数配置

## 与 project-index 的关系

两者功能完全一致：

| 特性 | pi-cli | project-index |
|------|--------|---------------|
| 入口 | `pi <command>` | `node scripts/xxx.js` |
| DAG 调度 | ✅ | ✅ |
| LLM 批量 | ✅ | ✅ |
| Dashboard | ✅ (SSE) | ✅ (轮询) |
| 代码结构 | 模块化 lib/ | 独立脚本 |

推荐使用 `pi` CLI 作为统一入口。

## 安全约束

LLM 任务自动注入安全前缀，禁止：
- 执行 git checkout / reset / clean
- 删除文件
- 修改实现代码（仅测试修复时）

## 经验教训

参见 [LESSONS.md](./LESSONS.md)

## License

MIT
