# dsh-timefold

DSH（DeepSeek Harness）的**会话回退 + 文件快照**插件。给每条你发过的消息加一个回退按钮：对话分叉回去，工作区文件也回到那一刻。

面向 **DSH 0.2.2-rc.x**，macOS / Windows 均可。

## 它解决的问题

DSH 自带的消息撤回只处理对话，不碰文件。市面上的两个方案各有短板：

| | 对话回退 | 文件回退 | 回填输入框 | 原会话保留 |
|---|---|---|---|---|
| dsh-rewind-plugin | 原地 replace | 只认记录到的编辑 | ✗ 有 bug | ✗ |
| dsh-recall-plugin | fork | ✅ 影子 git 快照 | ✅ | ✅ |
| **dsh-timefold** | fork | ✅ 影子 git 快照 | ✅ 且失败可见 | ✅ |

本项目 fork 自 [dsh-recall-plugin](https://github.com/limbo947/dsh-recall-plugin) 2.6.7，吸收了 [dsh-rewind](https://github.com/SiriLee/dsh-rewind) 的交互思路，并修掉两者已知缺陷。

## 功能

每条你自己发的消息下方，鼠标悬停出现操作行：

| 按钮 | 作用 |
|---|---|
| ⏱ 时间 | 消息发送时刻 |
| ⧉ 复制 | 复制消息正文 |
| ↶ 回退 | 选择「回退文件与对话」或「仅回退对话」，fork 出新分支 |
| ✎ 编辑 | 就地改写后重新发送（不动文件） |
| ↻ 重跑 | 回到消息之前并**立即重发**原文（文件和对话一起回退） |
| ✕ 删除 | 回到消息之前，草稿留空不发送 |

所有回退都是 **fork**：原会话保留为父分支，随时可切回，不是真删。

### 文件为什么能完整还原

每条消息发送时，工作区被快照进一个**独立的影子 git 仓库**（`--git-dir` / `--work-tree` 分离，完全不碰项目自身的 `.git`）。

这比「记录工具调用事件」强的地方在于：不管文件是被 `write`、`edit` 改的，还是被 `bash` 里的 `mv`/`cp`/`sed -i`、IDE 手动保存、甚至别的进程改的，只要在快照时刻之后变过，都能还原到字节级一致。

默认排除 `.gitignore` 里的内容、以及基础排除表，避免快照体积失控。

基础排除表内置了常见工具链的可重建产物（体积大、回退时无价值）：

| 类别 | 内置条目（节选） |
| --- | --- |
| 通用构建输出 | `node_modules/`、`dist/`、`build/`、`out/`、`target/`、`coverage/` |
| Xcode / iOS | `**/DerivedData/`、`**/Pods/`、`**/.build/`、`**/xcuserdata/`、`*.xcindex/`、`*.noindex/`、`**/SDKExplicitPrecompiledModules/`、`*.dSYM/` |
| Python | `**/__pycache__/`、`**/.venv/`、`**/venv/`、`**/.pytest_cache/`、`**/.mypy_cache/`、`*.pyc`、`*.egg-info/` |
| 前端 / Node | `**/.turbo/`、`**/.vite/`、`**/.next/`、`**/.nuxt/`、`**/.svelte-kit/`、`*.eslintcache` |
| Dart / Flutter | `**/.dart_tool/` |
| 系统垃圾 | `**/.DS_Store`、`**/Thumbs.db`、`*.log` |

`.vscode/`、`.idea/` 刻意**不**排除：体积小，且常含手写启动配置。

### 自定义排除

同容器下的 `exclude.txt`（与各工作区哈希目录同级）优先级高于基础表，一行一条，gitignore 语法。可以：

- **追加**：直接写新规则，立即生效，无需重启；
- **反悔**：用 `!` 恢复基础表里的**文件级**规则，例如 `*.log` 是内置的，写 `!important.log` 就能把它收回来；
- **注意**：gitignore 语义下**目录级排除无法恢复单个文件**——`**/Pods/` 之后再写 `!Pods/LocalPod/x.swift` 是无效的。要保留某个本地 Pod 的源码，只能把整条目录规则从基础表里拿掉（改插件配置的「基础排除表」），或改用更窄的路径规则。

基础表本身也能在插件设置的「基础排除表」里整体改写。

## 修掉的缺陷

### rewind issue #94：回退后输入框不回填

`dsh-rewind-plugin` 的回填链路有三处静默失败：

1. 读文本发生在回退命令**之后** —— 宿主 `nodes.filter()` 已把目标节点从事件区间剔除，读回 `undefined` 就静默 `return`
2. 宿主 `conversation.input.for(scope)` 在 session binding 失效时抛 `retained Session scope`，异常被空 `catch` 吞掉
3. 8 次重试耗尽后静默放弃，界面上毫无痕迹

本项目的处理：

- **文本在 fork 之前抓取**（来自 React 组件的 `node.data.content`，天然早于执行）
- 写入口按 `actions.setDraft` → `shell.setDraft` → **DOM `execCommand('insertText')` 降级**逐级兜底
- 写完**回读 `shell.snapshot.draft` 校验**（宿主的 Lexical 在文本相同时会提前 return，不校验会误判成功）
- 全部失败 → 日志 + toast 提示，**绝不静默**

### recall：孤儿快照清理不掉

会话删除后，快照可能残留，且「立即 gc」也清不掉。根因是 `rebuildOrphans()` 把找不到归属的 git tag **强行标成当前活会话**，`loadIndex()` 再次兜底填同一个 id，`saveIndex()` 把污染固化进 index.json。于是 sweep 逻辑认为这些快照属于活会话，永不回收。

本项目的处理：

- `rebuildOrphans()` 不再编造归属，无主 tag 记为**空归属**
- `loadIndex()` 归属只认磁盘原值，空就是空
- 新增 `reloadIndex()`：清掉只加载一次的守卫，强制从磁盘重读，用于纠正历史污染
- `sweepDeletedSessions()` 改为**先重读磁盘**，并把空归属快照按孤儿直接回收；有名有姓的要内存与磁盘都查不到才删

## 安装

插件依赖宿主为 DSH 桌面版（`dsh` >= 0.2.2-rc.1 < 0.3.0）。

### 从本地源码

```bash
# 1. 放到你喜欢的位置
cd ~/Documents
git clone <this-repo> dsh-timefold

# 2. 在 desktop profile 里加 file: 依赖
cd ~/.dsh/profiles/desktop
# 编辑 package.json：dependencies 加入
#   "dsh-timefold": "file:/绝对路径/dsh-timefold"
# dsh.profile.bundles 追加 "dsh-timefold"

pnpm install
```

> **注意**：不要用 `dsh plugin --profile desktop add ...` —— 桌面 profile 由 Electron 应用独占管理，该命令会被拒绝。改 `package.json` + `pnpm install` 是正确路径。
>
> `file:` 依赖是**硬链接复制**，改源码后必须 `rm -rf node_modules/dsh-timefold && pnpm install` 才会同步。

### 重启生效

装完 **⌘Q 完全退出**（关窗口不算），等 5 秒再打开。插件改动桌面版不会热重载。

## 配置

`~/.dsh/profiles/desktop/cordis.patch.yml` 里按 `id: timefold` 覆盖：

```yaml
- insert:
    - id: timefold
      name: 'dsh-timefold'
      config:
        gcSnaps: 50                   # 每积累多少快照触发一次 git gc
        gcHours: 24                   # 距上次 gc 超过多少小时触发
        maxFileBytes: 8388608         # 超过该大小的文件不进快照
        maxWorkspaceBytes: 268435456  # 单工作区快照总量上限，超限停用该工作区
        scanBudgetMs: 10000           # 快照前扫描时间预算
        refillDraft: true             # 回退后把原文回填输入框
```

设置页也有可视化面板（插件配置卡片 + 快照管理）。

## 快照存储

默认路径 `~/.dsh/dsh-timefold-snapshots/<工作区哈希>/`：

```
index.json     快照索引（id / time / root / sessionId）
git/.git       影子裸仓库
exclude.txt    排除表
```

`root.txt` 记录该库对应的工作区绝对路径。

home 不可写时退化到项目内的 `.dsh-timefold-snapshots`（该目录已在排除表中，不会自我快照）。

## 已知边界

- **快照只在消息发送时创建**。插件启用前的历史消息没有快照，不显示回退按钮
- 单个工作区超过 `maxWorkspaceBytes` 会停用该工作区的快照（并在设置页提示）
- 只支持 DSH 0.2.2-rc.x；0.3.0 起锚点可能变化

## 致谢

- [dsh-recall-plugin](https://github.com/limbo947/dsh-recall-plugin) —— 影子 git 快照与 fork 回退的原始实现
- [dsh-rewind](https://github.com/SiriLee/dsh-rewind) —— 交互形态与 issue #94 的定位线索

## License

MIT。详见 [LICENSE](LICENSE)，其中保留了上游 `dsh-recall-plugin` 的版权声明。
