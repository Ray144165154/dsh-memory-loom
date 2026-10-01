# dsh-memory-loom

> DeepSeek Harness 的**跨会话长期记忆与联想召回**插件。
> 让 agent 记住你上一次告诉它的偏好、约束和决定——并且在这次会话里**不需要你重复**。

---

## 它解决什么问题

DSH 的会话是隔离的。你在 A 项目里说过"这个仓库必须用 pnpm，不要用 npm"，下周开一个新会话，agent 一无所知，你得再说一遍。

`dsh-memory-loom` 做四件事：

| 阶段 | 做什么 |
|---|---|
| **捕获** | 每次模型调用前扫描最新的用户消息，用规则抽取其中的持久事实（偏好 / 约束 / 决定 / 明确要求记住的内容） |
| **存储** | 写进 DSH 自己的 storage domain（`agent_memory` 域），落在 `$DSH_HOME/storages` 下，重启和升级都不丢 |
| **联想** | 每写入一条，自动与共享实体或高重合标签的旧记忆建立关联边，形成一张图 |
| **召回** | 用当前用户消息做查询，三路打分后把最相关的几条注入系统提示词；模型也可以主动调 `memory_recall` |

"联想"不是修辞：召回分数里有一条是**在关联图上做激活传播**。这意味着一条**和你的问题没有任何共同关键词**的记忆，只要它关联着一条命中的记忆，也会被带到模型面前。这是纯关键词检索做不到的部分，也是这个插件的主要价值。

---

## 安装

### 1. 确认 `dsh` 命令

桌面版**不会**把 `dsh` 放进 PATH，CLI 真身在：

```
<app>\node_modules\@deepseek-ai\dsh\lib\bin.js
```

其中 `<app>` 是桌面版的安装目录，通常是
`%LOCALAPPDATA%\Programs\DSH Desktop\resources\app`。

### 2. 把插件挂进 web profile

把 `<插件检出目录>` 换成本仓库在你机器上的路径（例如 `C:\src\dsh-memory-loom`）：

```powershell
$plugin = '<插件检出目录>'
$env:DSH_HOME = "$env:APPDATA\dsh-desktop\harness"
$app  = "$env:LOCALAPPDATA\Programs\DSH Desktop\resources\app"
$node = "$app\node_modules\node\bin\node.exe"
$bin  = "$app\node_modules\@deepseek-ai\dsh\lib\bin.js"

& $node $bin plugin --profile web add "link:$plugin"
```

`link:` 让 pnpm 做符号链接，所以改代码后不需要重装。这条命令会把 `dsh-memory-loom` 追加进 profile `package.json` 的 `dsh.profile.bundles`。

> **`link:` 模式有个前提**：Node 解析裸模块说明符时会先 realpath，所以符号链接指向的源码目录必须自带 `node_modules`（`zod` 与 `@deepseek-ai/*` 的 peer）。否则插件会在导入时死于 `ERR_MODULE_NOT_FOUND`。仓库里的 `tools/dev-link.ps1` 会替你准备好这些链接，并会跑一遍自检来证明解析确实通了。

> 如果你更想用独立安装的 dsh CLI，`dsh plugin --profile web add "link:$plugin"` 等价——只要 `DSH_HOME` 指向上面那个目录，否则它会装到另一个 profile 里去。

### 3. 重启 DSH，然后确认

打开 **设置 → 插件 → 插件配置**：

- 出现 **长期记忆** 卡片（展开可看到计数、记忆列表和操作按钮）
- 模型侧多出 6 个工具：`memory_recall` / `memory_remember` / `memory_forget` / `memory_link` / `memory_backfill` / `memory_stats`

> **卡片为什么挂在"插件配置"这一页**：`settings.plugin.item` 不是一张自由卡片列表。插件页会遍历**已注册的 settings 命名空间**，对每个命名空间分发一次同名卡片——所以卡片的 `key` 必须等于宿主侧 `ctx.settings.register()` 注册的命名空间名。两者不一致时卡片**既不渲染也不报错**，只是永远不出现，这正是本插件首次安装时卡片缺失的原因。`SETTINGS_NAMESPACE` 与 client bundle 的 `key` 的相等关系由 `tools/smoke.mjs` 断言保护。
>
> 命名空间的 schema 是**空的**：它是挂载锚点，不是表单。本卡片只做状态展示与操作，真实配置在 profile 的 `cordis.patch.yml` 里。把 12 个配置键注册进命名空间会渲染出一个编辑"插件根本不读取的设置文档"的表单——一个会撒谎的界面。第一方的 `dsh-image-generation` 用的是同样的空锚点写法。

### 4. 让历史会话产生价值

新装的记忆库是空的。打开卡片点 **从历史会话回填**，或让 agent 调 `memory_backfill`，它会把过去会话里符合规则的持久事实一次性挖出来。

---

## 版本线兼容性（dsh 0.1.x / 0.2.x）

DSH 的 0.1.x 与 0.2.x 之间有**破坏性契约差异**。本插件对两条线都做了处理，差异是逐个读包内自带的 `.d.ts` 得出的，不是从调用点推断的：

| 契约 | 0.1.x（桌面版 0.9.2 / dsh 0.1.5-rc.2） | 0.2.0-rc.2（当前 `latest`） | 本插件的处理 |
|---|---|---|---|
| settings 服务 | `ctx.settings.register(ns, schema, { applies })` 存在 | **已移除**（`register` 在类型里 0 处）。`ctx.settings` 变成 `SettingsForms`：命名空间即 profile 条目 id，配置页从插件自己的 `Config` **自动生成**（`SettingsDescriptor.autoGenerate`） | `registerSettingsAnchor()` 特性探测，有 `register` 才调用 |
| 设置卡片槽位 | `settings.plugin.item`，按已注册的 settings 命名空间逐个分发 | **整棵树 0 处匹配** | 卡片注册包在 `try/catch` 里；0.2.x 上不显示卡片 |
| `defineTool` / `ctx.tools.register` | 存在 | 存在 | 无需改动 |
| `defineDomain` / `domainTable` | 存在 | 存在 | 无需改动 |
| `systemPrompt.section` | 存在 | 存在 | 无需改动 |
| `sessionQuery.listSessions` / `readSession` | 存在 | 存在 | 无需改动 |
| `connection.fetch.register`（本插件的 4 个 HTTP 接口） | `{ path, methods, requestBody, fetch }` | **形状完全相同**。路径校验为 `endpointFromPath('/api', path)` + `ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/`，接受本插件的 `/api/memory-loom.stats` 形式 | 无需改动 |

**为什么必须特性探测，而不是比版本号**：这些包在 npm 上独立发版，`latest` dist-tag 曾长期指向无关的 `0.0.1-rc.x` 构建——版本号不可靠，探 API 才可靠。

**为什么这个探测是必须的，而不是优化**：`settings.register` 在 0.2.x 上不存在，直接调用会抛 `TypeError` → `Service.init` 拒绝 → 插件激活失败。而**一个未激活的 loader 条目不只失去该插件的功能，还可能让整个 harness 启动失败**。也就是说 0.1.3 及更早的版本在 dsh 0.2.x 上是有害的，不是"卡片不显示"这种程度。

**当前验证状态**

- **0.1.x 线**：实测工作（工具、卡片、注入、持久化、4 个 HTTP 接口都验过）
- **0.2.0-rc.2 线**：宿主侧契约**已逐项核对**（读 0.2.0-rc.2 包内 `.d.ts` 与注册校验源码），结论是除 settings 与卡片槽位外全部兼容；但**尚未在真实 0.2.x harness 里启动过**，所以"激活"这一项仍属未实测
- **0.2.x 上的功能差异**：配置页由 `Config` schema 自动生成（12 个键都可编辑，这一点比 0.1.x 的只读卡片更好）；**自定义卡片不显示**——记忆清单与遗忘/回填按钮在 0.2.x 上没有界面入口，但 `memory_recall` / `memory_forget` / `memory_backfill` / `memory_stats` 工具照常可用

---

## 配置

配置写在 `$DSH_HOME\profiles\web\cordis.patch.yml` 里**本插件那一行**的 `config:` 之下。loader 只把这个子对象传给插件，写在外面的键会被静默忽略。

```yaml
- id: memory-loom
  config:
    enabled: true
    recallLimit: 6
    minScore: 0.12
    injectSection: true
    autoExtract: true
    autoExtractMax: 3
    associationHops: 1
    associationDecay: 0.35
    halfLifeDays: 45
    workspaceScoped: true
    maxRecords: 5000
    backfillSessions: 50
```

| 键 | 作用 | 调参直觉 |
|---|---|---|
| `enabled` | 总开关 | 关掉后工具仍在，但不再注入提示词、不再自动抽取 |
| `recallLimit` | 每次注入几条 | 6 是平衡点；调到 15+ 会开始吃掉上下文预算 |
| `minScore` | 注入的最低分 | **最重要的旋钮**。设为 `0` 等于"任何词重合都注入"，通常比没有记忆更糟；调高到 0.3 更保守 |
| `injectSection` | 是否注入系统提示词 | 关掉后就只剩模型主动调 `memory_recall` |
| `autoExtract` / `autoExtractMax` | 自动抽取开关与每条消息上限 | 见下方"它不是什么" |
| `associationHops` / `associationDecay` | 联想传播的跳数与衰减 | `hops: 2` 会显著扩大召回面，也显著增加噪声；`decay` 越小，间接关联衰减越快 |
| `halfLifeDays` | 时间衰减半衰期 | 45 天；长期项目可调到 180 |
| `workspaceScoped` | 是否按工作目录隔离 | `true` 时 A 项目记的事不会在 B 项目被召回 |
| `maxRecords` | 存储上限 | 超出后按 `salience × confidence × 新鲜度` 淘汰最弱的 |
| `backfillSessions` | 回填扫描多少个历史会话 | 只影响回填 |

改完保存即可，profile 是 `patchReload: live`，会热重组。

---

## 召回是怎么算出来的

三条信号加权：

| 信号 | 权重 | 说明 |
|---|---|---|
| 词法相关 | 0.55 | BM25 变体，字段加权：正文 1.0 / 标签 1.6 / 实体 1.8 |
| **联想激活** | 0.25 | 沿关联边传播，每跳乘 `边权 × decay^跳数`，多路径取 `max` 而非求和 |
| 时间新鲜度 | 0.12 | 以 `halfLifeDays` 为半衰期的指数衰减 |
| 使用频次 | 0.08 | `log1p(useCount)` 阻尼 |

再乘上 `(0.4 + 0.6×salience)` 和 `(0.4 + 0.6×confidence)`——注意是**缩放而不是门限**，所以一条低置信度的记忆在没有任何更好选择时仍然能被召回，但在同分时绝不会盖过高置信度的。

最后做两件事：按归一化正文去重（同一事实换句话说是同一内容哈希，但跨会话可能出现近邻改写），以及**每个会话最多占 2 个名额**，避免一次长会话垄断所有召回位。

中文分词用 **CJK 二元组**（bigram），英文用整词 + 停用词表。没有引入分词库，因为 BM25 的 idf 项本来就会压低高频词的权重。

---

## `autoExtract` 是规则，不是 LLM

这一点必须说清楚，因为它决定了你会看到什么行为。

自动抽取是**纯规则**的：四条正则线索表，覆盖 `preference` / `constraint` / `decision` / `fact` 四类，每条都要求出现明确的措辞线索（"记住""必须""我更倾向""from now on""we'll use"……）。它**不会**：

- 调用模型做摘要（那会让每次 prompt 组装多一次网络往返，翻倍延迟和成本）
- 产出 `entity` / `task` / `insight` 三类（这三类交给 `memory_remember` 工具，让模型带着完整上下文自己判断）
- 把问句当事实存下来（含线索的问句也会被跳过："你记住了吗？"不会被存成一条关于"记住"的记忆）

代价是**召回率不高**：很多真正值得记的句子没有线索词，会被漏掉。收益是**确定性**——你可以预测它会记什么、可以审计、猜错了删掉就行，而不是面对一个悄悄改写了你意图的摘要器。

如果你要更高的召回率，正确做法是让 agent 主动用 `memory_remember`——工具的描述里已经把"什么值得记、什么不值得记"写清楚了。

**要不要关掉它**：实测下来两边差距很明显。规则抽取在真实的、任务导向的会话里产出 0 条（5 条真实消息里 1 条是命令、2 条是 harness 注入文本、2 条是"物理"这类短词），而它的两次误判都是把 harness 自己的提示词写进了用户记忆库；反过来，模型主动调 `memory_remember` 写的记录质量一直很稳。所以**规则抽取的投入产出比是负的**——它偶尔漏掉本该记住的句子，却需要你付出审阅与清理的成本。

关掉它（`autoExtract: false`）只留工具路径是稳妥的默认选择；注入的两个向量已经修好并有回归断言保护，所以打开也不是"有害"，只是收益有限。这是一个质量偏好，不是规避。

---

## 数据在哪，怎么清

- **位置**：`$DSH_HOME\storages` 之下由 storage-domain 管理的 `agent_memory` 域。`layout: per-record`，一条记录一个文档，方便单条备份或手工删除。
- **清空全部**：停掉 DSH，删掉该域对应的目录即可。属于派生数据的取舍——记忆丢了可以回填，但**不会**自动重建。
- **清单条**：卡片上每条记忆右侧的"遗忘"，或让模型调 `memory_forget`（默认是"取代"而不是物理删除，保留可审计的痕迹和关联图结构）。

---

## 卸载与回滚

三种力度，按需要选：

```powershell
# 1) 临时禁用（可热重载，改 profile 的 patch 层）
#    在 $DSH_HOME\profiles\web\cordis.patch.yml 里加：
#    - id: memory-loom
#      disabled: true

# 2) 彻底卸载（同时从 bundles 列表移除）
& $node $bin plugin --profile web remove dsh-memory-loom

# 3) 连同数据一起清掉：停掉 DSH，删除 $DSH_HOME\storages 下的 agent_memory 域目录
```

第 1 种是 dshmarket 也在用的官方热禁用机制，约 1 秒内重组成、不用重启。

---

## 开发

### 两种安装形态，用一条命令切换

```powershell
# 联调模式（默认）：link: 安装 + 插件目录自带的 node_modules
# 改完源码只需重启 DSH，不用重新打包
pwsh -File tools\dev-link.ps1

# 发布形态：打包成 tarball 再装
pwsh -File tools\dev-link.ps1 -Mode pack
```

`tools/dev-link.ps1` 做的事，以及它为什么存在：

| | `link:` 联调模式 | tarball 发布模式 |
|---|---|---|
| 安装物 | profile 里的符号链接指向源码目录 | profile 里的真实目录 |
| 改源码后 | 重启 DSH 即可 | 必须重新 `pack` + `add` |
| 依赖解析 | **插件目录必须有自己的 `node_modules`** | pnpm 从 profile 树向上解析，无需额外准备 |
| 脚本负责 | 建 junction、跑自检、切换 profile | 建 junction（为跑自检）、打包、删 junction、切换 profile |

`link:` 模式为什么需要那些 junction：Node 解析裸模块说明符（`zod`、`@deepseek-ai/*`）时会先 **realpath**，所以即使 profile 的 `node_modules` 里是符号链接，实际查找位置仍是源码目录。没有那个 `node_modules`，插件会在导入时直接死于：

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis'
```

脚本用 `cmd /c rmdir` 删除 junction，**不用** `Remove-Item -Recurse`——后者在目录 junction 上可能递归进目标，删掉 DSH 应用自己的 `node_modules`。

两种模式下，**宿主侧改动都需要重启 DSH**：已在运行的进程内存里持有旧模块。

### 离线自检

```powershell
# 不需要启动 harness：52 项断言，覆盖模块解析、schema 编译、分词、抽取规则、
# 注入文本剥离、排序、联想传播、真实 store 的写入/关联/淘汰、工具执行、
# 清单契约（含 BOM、"卡片 key = settings 命名空间"两条）
node tools\smoke.mjs
```

`tools/dev-link.ps1` 会在切换前自动跑它，并把"能跑通"当作模块解析正确的证明。手工执行时需要先有 junction——直接跑脚本即可。

---

## 已验证 / 未验证

诚实地说清楚边界，比一个漂亮的"已完成"有用。

### 离线已验证（`node tools/smoke.mjs` —— 51 项断言，0 失败）

**模块与 schema**

- 模块解析：`@deepseek-ai/cordis` 的 `Service`、`@deepseek-ai/schemastery` 的 `Config`、`@deepseek-ai/dsh-storage-domain` 的 `defineDomain`/`domainTable`、`@deepseek-ai/dsh-tools` 的 `defineTool`、`zod` 全部真实可导入
- `Config` schema 能应用 12 项默认值
- `agent_memory` 域声明通过 `defineDomain` 的加载期校验

**分词与抽取**

- 英文整词 + 停用词表；CJK 二元组
- 四类线索各自命中；线索冲突时的优先级；含线索的问句被排除；无关对话零产出；内容寻址 id 的空白不敏感性；实体提取（路径 / URL / 反引号标识符）

**排序与联想**

- 关键词命中排序、工作区作用域过滤（含开关两侧）
- 纯排序层：零词法重合的记录能通过关联边被召回；`hops: 0` 时关联关闭；已取代的记录不召回；空查询返回空

**真实 store + 工具集成**（真实 `MemoryStore` 跑在内存假 domain 上，除磁盘 I/O 外全部是真实现）

- store 打开、写入、**写入时自动关联**、关联边在召回中真实传导
- 仅靠标签相似度建立关联时，能召回到**词法重合严格为 0** 的记录（这条是本插件的核心性质）
- 重复观测是**强化**而非新增记录，且 `salience` / `confidence` 向最强观测取齐
- `touch` 计次、淘汰上限生效
- **六个工具的 `defineTool` schema 全部编译通过**——这是会在插件加载期直接抛错的高风险面
- `memory_remember` / `memory_recall` / `memory_stats` / `memory_forget` 实际执行，且**返回对象的键与声明的 output schema 逐一比对一致**
- `sessionQuery` 不可用时 `memory_backfill` 抛出可读错误（而不是让插件不激活）

**注入文本不得变成记忆**（这条来自真实启动中的一次发现，见下）

- 真实形状的 runtime context 前导块 → 0 条候选，且剥离后为空串
- 前导块之后跟着一句真实偏好 → 恰好 1 条，且是被剥离后的偏好而不是样板文本
- 用户消息恰好以 `Current runtime context.` 开头但并非注入块 → **原样保留**，不被吞掉
- `latestUserText()` 用作召回查询时会剥掉前导块

**清单契约**

- `dsh.bundle.patch` 指向真实文件、`files` 列表无缺项、client bundle 的 `id` 与包名一致
- **`cordis.patch.yml` 里的 config 键与 `Config` 声明完全一致**（键名打错会被 schema 静默丢弃，读起来就像"这个设置没生效"）

一个真实的收获值得记下来：**"关联只能沿出边传播"这个缺陷就是被这个测试抓出来的**。我在测试里手工构造了一条单向边，结果联想完全不工作。真实写入路径用的是对称边，所以线上表现正常——但一个只在单向边上失效的排序器，失效时不会有任何报错，只是召回悄悄变差。现在改成双向遍历，并加了这条断言。

### 已在真实 DSH 进程中验证

用一个**独立 DSH_HOME**（临时目录下的 `_dshtest`）做了真实安装与启动，**验证全程没有碰正在运行的 profile**（测试 home 与临时脚本已删除）。验证通过后又按需求把插件装进了真实的 web profile，装配确认无 load 错误。

> **装上之后立刻会发生什么**：`autoExtract` 默认开启，所以插件会从**所有会话**的用户消息里抽取持久事实（本插件不做自动回填，回填只在卡片或工具里手动触发）。记忆库落在真实 `$DSH_HOME\storages\agent_memory` 下。想先观察不写入，把 profile patch 里本行的 `autoExtract` 改成 `false` 即可。

- **真实安装**：`dsh plugin --profile web add "link:<插件检出目录>"` → pnpm 成功，且 `dsh` 自动把 `dsh-memory-loom` 追加进 `dsh.profile.bundles`。这一步顺带证明了 bundle 声明正确——CLI **只**把确实声明了 `dsh.bundle.patch` 的依赖加入 bundles，否则会警告 `declares no dsh.bundle` 并当普通依赖处理。
- **真实启动**：实例在 `127.0.0.1:44777` 起来，`Service.init` 跑完、storage domain 打开、`connection` 可选注入生效。
- **`Config` 真的生效**：`GET /api/memory-loom.stats` 返回的 config 正好是 schemastery 的默认值——profile 那一行没有写 `config:`，所以这些值只能来自 `static Config`。
- **真实持久化（写 + 读）**：回填后磁盘出现 `storages/agent_memory/memories/<hash>.json`，信封为 `{version, record}`，UTF-8 文本与 CJK 二元组标签正确；**完整重启后从磁盘加载回 2 条**——这条路径会跑一遍 zod 校验，所以记录 schema 也被真实验证了。
- **去重 / 强化语义**：3 条克隆消息循环映射到 2 段文本 → `added: 2, strengthened: 1`，与预期精确吻合。
- **`sessionQuery` 真实读取**：`listSessions` 找到会话，`readSession` 成功解码**多帧 zstd** 日志（每条日志 103~109 个独立帧），`unreadable: 0`。
- **`collectText` 在真实载荷上工作**：从真实 `user/message` 事件恢复出文本。
- **4 个 HTTP 路由全部实跑**：`stats` / `backfill` / `evict` / `forget`；`forget` 后统计变成 `live=1 superseded=1`，取代语义正确。

### 真实启动中发现并修掉的一个缺陷

第一次回填抽取结果是 0 条。我把真实消息逐条解出来才看清原因：5 条里 1 条是安装命令、**2 条是 harness 注入的 runtime context**、2 条是"高斯定理""物理"这类短词——**0 条是正确结果，不是漏抽**。

但那条注入文本暴露了一个真实假阳性：它**确实会进入 `user/message` 载荷**，而且读起来就是策略。实测证明，一段形如 `Do not call image_generate. Never ask for an API key in conversation.` 的注入文本会被存成**两条"用户约束"记忆**。任何 runtime context 措辞里带 "must" / "never" 的部署，都会把自己的样板文本永久写进用户记忆库，还署着用户的名。

修法：`lib/text.js` 新增 `stripHarnessPreamble()`，在**抽取**和**召回查询**两处剥离 runtime context 前导块。剥离刻意保守——要求精确的 `Current runtime context.` 开头，只删前面形如策略段落的块，其余原样返回；没有这个开头就完全不碰。配了 4 条断言，包括"用户消息恰好以该短语开头时不得被吞掉"。

边界说明：注入的**提示词 section** 是另一条路径，它们不会进入 `user/message` 载荷，因此不在这里处理——对它们的措辞做猜测只会引入假跳过。

### 已在真实模型轮次中验证

下面三项原先列为未验证，现已在其运行环境里实测通过：

- **6 个工具被模型实际调用**：`memory_stats` 返回 `{total:6, live:4, superseded:2, links:4, by_kind:[preference:2, constraint:1, insight:1]}`；`memory_remember` 两次写入均 `created: true`，其中一次带显式关联返回 `linked: 1`；`memory_recall` 正常返回带分数的结果，且返回键与声明的 output schema 一致。
- **联想在真实数据上成立**：以 `tarball repacking workflow ERR_MODULE_NOT_FOUND` 查询，词法命中的是一条 tarball 记忆（score 0.782, `via: lexical`），而**与查询零关键词重合**的 pnpm 偏好以 `via: association`（score 0.205）被关联边带出。这是本插件的核心性质在生产数据上的直接证据。
- **设置卡片的浏览器渲染**：卡片已在 **设置 → 插件 → 插件配置** 正常显示（此前缺失的原因见上文第 3 步的说明）。

### 仍未验证

- **提示词注入在真实 turn 中的实际效果**：section 的*注册*已被证明（否则 `Service.init` 会抛错、路由与工具都不会存在），注入的召回块也已通过 `memory_recall` 间接验证，但"模型是否真的按注入内容行动"没有单独观测。

关于失败模式，有一点值得指出：装配钩子里读取会话是全程可选链的——`context?.agent?.session`，拿不到就退化成空事件列表，即"不注入"，而**不会**让这一轮对话出错。所以即使我对 assemble 上下文字段的假设有偏差，后果也是记忆静默不生效，而不是把对话弄坏。

### 明确的设计取舍

- **不调用被默认禁用的 FTS**。web profile 里 `session-query-sqlite` 是 `openAt: never`、索引 `:memory:`，全文检索默认关闭。回填走的是 `listSessions` / `readSession`，这两个不依赖 SQLite 索引，所以**不需要改任何 profile 配置**。（这一点是我在你机器上 dump 装配清单时发现的：如果有人按"用 sessionQuery 做检索"的思路写，会在运行时撞上 `SESSION_QUERY_SEARCH_DISABLED`。）
- **不直接读磁盘上的 session 日志**。它们是 `session.jsonl.zstd`（zstd 压缩），自己解压意味着要额外拥有一个解压器、一套目录 slug 推导和一份格式版本——这三样 harness 都已经拥有并通过 `sessionQuery` 暴露了。
- **`sessionQuery` 是可选注入**。必需服务缺失不只是插件不激活，而是**整个 harness 拒绝启动**（一个 entry 没激活就会 fail the boot）。所以它降级成"`memory_backfill` 报一条清楚的错"，而不是让 profile 起不来。

---

## 后续可以加的东西

按价值排序：

1. **LLM 抽取器**：在 `extract.js` 旁边加一个可选的模型抽取路径，用于用户明确说"记住这次讨论"的场合。`extractCandidates` 的返回形状已经是为可替换设计的。
2. **向量召回**：目前第三条腿是关键词 + 图。加一路 embedding 需要模型 provider，但会让同义改写也能命中。
3. **记忆的自动冲突检测**：已经存了 `contradicts` 这种边类型，但还没有任何东西会自动创建它。两条共享实体、语义相反的 `decision` 应该被标出来让 agent 复核。
4. **会话结束时的反思轮**：目前抽取是"每次模型调用前顺带做"，粒度是单条用户消息。在 `turn/end` 之后做一次整轮摘要质量会更高（但需要接 session 事件，而事件是 contained 作用域的，需要单独验证投递语义）。

---

## 许可

MIT。
