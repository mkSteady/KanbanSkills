# DAG 依赖调度

BatchRunner 支持 DAG（有向无环图）依赖调度，确保任务按依赖顺序执行。

## 使用场景

### 目录层级处理

生成文档时，子目录必须先于父目录完成，这样父目录可以引用子目录的内容：

```
js/agents/core/sandbox/system  → 先完成
js/agents/core/sandbox         → 等 system 完成后
js/agents/core                 → 等 sandbox 完成后
```

### 依赖图传播

修改底层模块后，依赖它的模块需要按顺序更新：

```
shared/utils (修改) → core → plugins → stages
```

## API

### TaskItem.dependencies

```javascript
const tasks = [
  { id: 'js/agents/core', dependencies: ['js/agents/core/archive', 'js/agents/core/sandbox'] },
  { id: 'js/agents/core/archive', dependencies: [] },
  { id: 'js/agents/core/sandbox', dependencies: ['js/agents/core/sandbox/system'] },
  { id: 'js/agents/core/sandbox/system', dependencies: [] }
];
```

### 自动计算目录依赖

module-analyzer 在 scan 阶段自动计算：

```javascript
scan: async () => {
  const allPaths = modules.map(m => m.path);

  return modules.map(m => {
    // 找出直接子目录
    const dependencies = allPaths.filter(p =>
      p !== m.path &&
      p.startsWith(m.path + '/') &&
      // 只要直接子目录，不要孙子目录
      !allPaths.some(other =>
        other !== p && other !== m.path &&
        other.startsWith(m.path + '/') &&
        p.startsWith(other + '/')
      )
    );

    return { id: m.path, dependencies, ... };
  });
}
```

## 调度行为

1. **无依赖任务** 立即进入并发池
2. **有依赖任务** 等待所有依赖完成后才启动
3. **并发池** 始终尽量填满（默认 40 槽位）
4. **循环依赖** 抛出明确错误，列出阻塞任务

### 执行示例

```
[11:21:20] Processing: js/agents/core/sandbox/system  ← 叶子节点先启动
[11:21:20] Processing: js/agents/core/archive
[11:21:20] Processing: js/agents/core/contracts
...
[11:25:51]   → processed: js/agents/core/sandbox/system
[11:25:51] Processing: js/agents/core/sandbox  ← system 完成后启动
...
[11:31:15]   → processed: js/agents/core/sandbox
[11:31:15] Processing: js/agents/core  ← sandbox 完成后启动
```

## 向后兼容

- 无 `dependencies` 字段时，行为与旧版一致
- 任务按输入顺序启动（先到先得）
- 不在本次运行的依赖视为已满足（resume 模式兼容）

## 错误处理

循环依赖或不可满足依赖时：

```
Error: Circular dependency detected (or unmet dependencies).
Blocked tasks:
- js/agents/core waiting for: js/agents/core/sandbox
- js/agents/core/sandbox waiting for: js/agents/core
```

## 性能考虑

- 依赖检查是 O(n) 复杂度
- 大量任务时（1000+），考虑预计算依赖图
- 并发数设置建议：CPU 密集型任务用 CPU 核数，I/O 密集型可设更高（40-60）
