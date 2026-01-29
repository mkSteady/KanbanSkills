# 经验教训 (Lessons Learned)

开发和维护 project-index 过程中积累的设计经验。

## 1. 源文件规则 ≠ 测试文件规则

### 背景
`stale-config.json` 的 `ignore` 列表通常包含 `tests/**`（用于忽略测试文件作为源文件分析），`include` 列表如 `js/agents/**` 限定源文件范围。

### 设计要点
- **扫描测试文件时**：需要过滤掉 `tests/**` 等 ignore 规则
- **匹配测试文件时**：需要将 `js/agents/**` 转换为 `tests/unit/agents/**`

### 代码位置
- `lib/test/generator.js`: `scanTestFiles()`, `transformIncludeForTests()`

---

## 2. mtime 竞争条件

### 现象
批量更新测试文件时，某些源文件可能被 IDE 或其他进程同时修改，导致刚更新的测试又变成 stale。

### 缓解方案
1. 接受一定的残留 stale（下次迭代处理）
2. 可以添加 `--force` 选项忽略 mtime 检查
3. 在更新前暂停文件监听（如果可控）

### 教训
- mtime 是动态的，不要期望一次操作达到 100% 完美
- 幂等设计：多次运行应该收敛

---

## 3. LLM Provider 配置

### 支持的 Provider
| provider | 说明 |
|----------|------|
| `codex` | 通过 codeagent-wrapper 调用 Codex |
| `gemini` | 通过 codeagent-wrapper 调用 Gemini |
| `claude-cli` | 直接调用 claude CLI |

### 配置示例
```json
{
  "llm": {
    "provider": "codex",
    "timeout": 2700000
  }
}
```

### 代码位置
- `lib/llm/batch.js`: `callProvider()`
- `lib/test/fix.js`: `callLLM()`

---

## 检查清单

添加新的文件扫描功能时：

- [ ] ignore/include 规则是否区分源文件和测试文件？
- [ ] 路径模式是否需要在 src/test 目录间转换？
- [ ] 并发操作是否有 mtime 竞争条件？
- [ ] LLM 调用是否支持配置的 provider？
