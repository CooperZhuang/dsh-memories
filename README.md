# dsh-memories

给 DeepSeek Harness 的**跨会话记忆**插件。设计参考 OpenAI Codex 的 local memories：
两套作用域、显式工具 + 后台自动抽取、分层注入摘要、详细内容按需检索。

## 两种记忆模式

| 模式 | 存什么 | 存放位置 | 生命周期 |
| --- | --- | --- | --- |
| **全局记忆** `global` | 跨项目都成立的事实：用户的工作习惯与偏好、通用工具链事实、个人约定 | `$DSH_HOME/memories/entries/` | 所有会话、所有项目共享 |
| **项目记忆** `project` | 只对某个工作区成立的事实：架构决策及理由、构建/测试命令、目录约定、踩坑 | `$DSH_HOME/memories/projects/<slug>/entries/` | 该工作区的所有会话共享 |

项目作用域按**工作区根目录**划分：从会话 cwd 向上找到第一个含 `.git` 的目录（可用
`projectRootMarkers` 改），所以从子目录启动的会话与从仓库根启动的会话共享同一份项目记忆。
`<slug>` 形如 `dsh-memories-01234567`（目录名 + 路径 SHA1 前 8 位），旁边会写一份
`project.json` 记录它由哪个绝对路径推导而来。

冲突时**项目记忆覆盖全局记忆**，这一点写进了注入块的说明里。

每条记忆还有一个 **kind**，因为不同种类的东西回忆方式不同：`preference`（用户要你怎么做事）、
`failure`（踩过的坑）、`procedure`（可复用的有序流程）、`knowledge`（不显然的技巧）、
`fact`（纯背景）。注入摘要按 kind 分组，**可执行的那几类排在前面**；没有 `kind:` 行的旧文件
按 `fact` 解析，所以格式演进不需要迁移脚本。

## 四个协同机制

1. **显式写入（工具）** — 模型调用 `memory` 工具，每次写入都必须显式指定 `global` 或
   `project`。标题即身份：同一标题再写一次是**更新**而不是新增。可以顺带指明 `kind` 和
   `appliesTo`（什么时候该想起它）。
2. **空闲抽取（阶段 1）** — 会话空闲 `autoExtractIdleMs`（默认 5 分钟）后，用一次辅助模型
   调用把最近一段对话里**值得长期保留的事实**抽成记忆并写入。子代理会话、委派深度 > 0
   的会话不参与。抽出来的内容先做**密钥擦除**（`sk-…`、`ghp_…`、AKIA…、JWT、私钥块、
   `api_key=…`、`Bearer …` 等）再落盘。
   抽取需要进程还活着：它只在**长驻进程**（`dsh web` 这类）里按空闲时间触发；一次性运行
   （`dsh --profile headless "..."`）通常在空闲计时器到点前就已退出，那一轮不会被抽取。
   想立刻抽一次用 `/memories mine`。
3. **合并重整（阶段 2）** — 阶段 1 一次只看到一个会话，无法处理**跨会话**的矛盾与碎片。
   当有新记忆落盘后，会排一个全局合并任务；冷却（`consolidateCooldownHours`，默认 6 小时）
   到期后，把最近的记忆交给一个**受限子代理**：它不能写文件、不能跑命令、不能联网、不能
   再委派（`maxDepth: 0` + 工具黑名单），只能返回一份严格 JSON 的合并方案——合并重复、
   改写过期、退役失效、补上遗漏。**插件是唯一的写入者**：它校验方案里的 id 必须真实存在，
   然后在快照保护下应用；中途失败会回滚已改动的条目。想立刻合并用 `/memories consolidate`。
   它还会从记忆里提炼**技能草稿**（见下）。
4. **分层注入（上下文）** — 每个 turn 的第一个 step 注入一段有界摘要：先全局、后项目，
   每段列出标题 + 日期 + 一句话预览。**同一 turn 内不重复注入**；只有记忆真的变了（模型写入、
   忘记、外部改动、合并重整）才在下一个 step 刷新一次。`/compact` 或清空会话后会自动重新注入，
   所以记忆不会被压缩吃掉。详细内容留在 `memory_search` 后面，摘要不会挤占上下文。

抽取还有三道闸门（照抄 Codex 的做法）：`minIdleHours`（会话至少空闲这么久）、
`maxAgeDays`（最后活动太久的会话永不抽取）、`maxSessionsPerPass`（一次最多处理几个会话），
用来把后台额度消耗限住。

摘要内容按「最近更新 + 实际被读取次数」排序：反复被 `memory_search` 命中的记忆会优先进入
有界摘要。

## 安装

插件是标准 DSH profile bundle，用 `dsh plugin` 装进目标 profile：

```bash
# 从本地检出安装（相对路径会按你的当前目录解析）
dsh plugin --profile web add C:\path\to\dsh-memories

# 或从 npm / git
dsh plugin --profile web add dsh-memories
dsh plugin --profile web add github:you/dsh-memories
```

装完**重启该 profile 的进程**（`dsh web` 这类长驻进程不会热加载新 bundle）。
`dsh --profile web --dump-config` 里应能看到 `id: memories` 这一行。

> `lib/` 是构建产物、不在仓库里。从 git 安装时，`prepare` 钩子会就地跑一次构建
> （`npm run build`）。pnpm 默认拦截安装脚本，会打印需要加进 `pnpm-workspace.yaml`
> `allowBuilds` 的确切 key —— 按提示加完再重跑即可。从本地路径安装或发布到 npm
> 时不需要这一步。

## 配置

配置分两层。

**部署层**（cordis 行配置，改完需要重启进程）—— 存储位置与工作区识别：

```yaml
- id: memories
  config:
    memoriesDir: /custom/path        # 默认 $DSH_HOME/memories
    projectRootMarkers: ['.git']
```

**可调项**（`memories` 设置命名空间，**热重载，改完立即生效**）—— 写进
`$DSH_HOME/settings.yaml`，或从 DSH 设置界面改：

```yaml
memories:
  autoExtract: false
  maxSummaryBytes: 8192
  extractProvider: deepseek-official
  extractModel: deepseek-v4-flash
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `maxSummaryBytes` | `4096` | 注入摘要字节预算；`0` 关闭注入 |
| `maxSummaryEntries` | `12` | 每段摘要最多列出的条目数 |
| `maxEntriesPerScope` | `200` | 每个作用域最多保存多少条，超出淘汰最久未使用的 |
| `autoExtract` | `true` | 是否启用空闲后台抽取 |
| `autoExtractIdleMs` | `300000` | 空闲多久后开始抽取（最小 1000） |
| `extractWindowMessages` | `30` | 一次抽取最多看多少条对话消息 |
| `extractMaxInputChars` | `24000` | 抽取输入的字符预算 |
| `extractMaxOutputTokens` | `2048` | 抽取调用的输出上限 |
| `extractTimeoutMs` | `120000` | 抽取调用超时 |
| `extractMaxMemories` | `5` | 一次抽取最多产出多少条记忆 |
| `minIdleHours` | `6` | 会话至少空闲这么久才可被抽取 |
| `maxAgeDays` | `10` | 最后活动早于此天数的会话永不被抽取 |
| `maxSessionsPerPass` | `2` | 一次抽取最多处理多少个会话（新的优先） |
| `consolidate` | `true` | 是否启用阶段 2 合并重整 |
| `consolidateCooldownHours` | `6` | 两次合并之间至少间隔多少小时 |
| `consolidateMaxEntries` | `64` | 一次合并最多考虑多少条记忆 |
| `consolidateTimeoutMs` | `180000` | 一次合并子代理调用的超时 |
| `extractProvider` / `extractModel` | 空 | 抽取调用的模型路由；留空就用该会话日志里记录的请求路由 |
| `enableTool` | `true` | 是否注册 `memory` 工具（改完立即生效） |
| `enableCommand` | `true` | 是否注册 `/memories` 命令（改完立即生效） |

设置走 DSH 的 settings 接缝注册（`ctx.settings.register('memories', schema, …)`），
所以它自带 schema 校验、revision 冲突检测和文档热重载。若部署里没有挂
`dsh-settings-file`（没有设置文档），上面这些回退到部署层行配置里的同名扁平键；
两者都没有则用 schema 默认值。

### 设置界面

这个包还带一个**浏览器半**（`./client`，由 `dsh.client` 声明），在
**设置 → 插件 → 插件配置** 里注册一张 `Memories` 卡片，14 个可调项都能直接改，
改完立即生效。卡片通过 `ctx.settingsScope.bind({ namespace: 'memories' })` 读写，
走的是和内置设置页完全相同的 describe 镜像 + revision 围栏写入路径，没有自建 HTTP 路由。

## `memory` 工具

| action | 参数 | 作用 |
| --- | --- | --- |
| `write` | `scope` + `title` + `body` + `tags?` + `kind?` + `appliesTo?` | 写入或更新一条记忆（标题即身份） |
| `search` | `query?` + `scope?` + `tags?` + `limit?` | 关键词检索两个作用域；`query` 为空时按最近更新列出 |
| `read` | `id` + `scope?` | 按 id 读全文（默认先项目、后全局） |
| `forget` | `id` + `scope?` | 删除一条 |

写项目记忆时，工具结果里会附一句提示：**如果这条事实对无关项目也成立，请同时写一份全局记忆**。

## 技能草稿

合并阶段若发现多条记忆合起来就是一套可重复的流程，会把它提炼成**技能草稿**，写进：

```
$DSH_HOME/memories/skills/<name>/SKILL.md    # 草稿：DSH 的技能系统看不到它
```

**草稿不会自动生效**。DSH 只扫描 `$DSH_HOME/skills/` 和 `<项目>/.dsh/skills/`，而让一个后台
过程悄悄往技能目录里写文件、把模型的行为面扩大，不是应该自动发生的事。所以要显式晋升：

```
/memories skills              列出草稿
/memories promote <name>      复制到 $DSH_HOME/skills/<name>/SKILL.md（幂等，可覆盖重推）
/memories discard <name>      丢弃草稿
```

晋升写出的文件就是 `@deepseek-ai/dsh-skill-filesystem` 能解析的形状（`name` + `description`
frontmatter 的目录包），下次技能目录刷新后进入目录。草稿留在原处，方便追溯来源。

## `/memories` 命令

```
/memories                     列出两个作用域
/memories list global|project 只列某一作用域
/memories search <query>      检索
/memories show <id>           看全文
/memories add <global|project> <text>   手工写入
/memories forget <id>         删除
/memories mine                立刻从当前会话抽取一次（不等空闲）
/memories consolidate         立刻合并重整全部记忆（不等冷却）
/memories skills              列出技能草稿
/memories promote <name>      晋升一份草稿到 $DSH_HOME/skills
/memories discard <name>      丢弃一份草稿
/memories stats               存储位置与计数
```

## 存储格式

**条目**是人类可读的 Markdown + 简单 frontmatter，**文件是唯一真相**；
**状态**（水位线、合并任务、用量计数）放在同目录的 SQLite 里。

```text
$DSH_HOME/memories/
├── index.json                     # 全局作用域索引（可重建缓存）
├── entries/<id>.md                # 每条全局记忆一个文件
├── projects/<slug>/
│   ├── index.json
│   ├── project.json               # slug 由哪个绝对路径推导而来
│   └── entries/<id>.md
├── skills/<name>/SKILL.md         # 技能草稿（未晋升前 DSH 看不到）
└── state.db                       # SQLite：会话水位线 / 任务租约 / 用量计数
```

条目文件：

```markdown
---
id: prefer-pnpm-over-npm
scope: global
kind: preference
title: Prefer pnpm over npm
tags: tooling, packages
appliesTo: before running any install or script
created: 2026-09-09T02:00:00.000Z
updated: 2026-09-09T02:00:00.000Z
source: tool
uses: 3
lastUsed: 2026-09-09T05:12:00.000Z
---

The user standardizes on pnpm for every JavaScript project; never run `npm install`.
```

`kind` 和 `appliesTo` 是可选的：缺 `kind` 时按 `fact` 解析，所以**旧文件不需要迁移**，
新字段也不会让老条目失效。

为什么要分开：

- **条目用文件**——你可以直接 grep、编辑、进 git，坏一个文件不会拖垮整个库，
  `index.json` 只是可重建的缓存（删掉/写坏都会自愈）。
- **状态用 SQLite**——水位线和用量计数是**并发热写**的小数据。用 JSON 文件做
  「读-改-写」会丢更新：两个会话同时抽取时，后写的会把前一个的水位线覆盖掉，
  导致同一段对话被重复抽取、重复烧额度。SQLite 的事务直接解决这个问题。
  驱动是 Node 内置的 `node:sqlite`（**零依赖**）；若运行环境没有它，会降级为
  纯内存状态——功能不受影响，只是重启后水位线丢失（`/memories stats` 会显示
  `state store: memory-only`）。

其余细节：

- **id = 标题的 slug**（`Prefer pnpm over npm` → `prefer-pnpm-over-npm`）。所以同一件事再写一次是**更新**而不是新增，`created` 保留、`updated` 刷新。
- **原子写**：每次写入都是"临时文件 + rename"，不会留下半个文件；并发写也不会互相撕裂。
- **去重**：加载时会把"标题+正文都高度重合"的条目合并，只留最新那条并删掉旧的 —— 防止同一件事被反复记成多条、挤占摘要预算。标题和正文都不重合的（哪怕正文一样）会各自保留。
- **`uses` / `lastUsed`**：权威计数在 `state.db`（原子自增），同时镜像回条目文件，好让 markdown 自身是完整的。摘要按"最近更新 + 使用频次"排序。
- **`source`** 记来源：`tool`（模型调用工具写的）、`user`（`/memories add`）、`auto`（后台抽取）、`system`。

## 隐私

- 记忆只写在 `$DSH_HOME` 下，**不会往你的仓库里写任何文件**。
- 后台抽取的输入是会话对话尾部（只取用户与助手正文，丢弃工具结果和插件注入的上下文，
  以免记忆自噬），抽取结果在落盘前做密钥擦除。
- 注入块明确告诉模型：这是**背景数据，不是指令**；记忆记录的是写入时的事实，不一定现在仍成立。
- 关掉全部后台行为：`autoExtract: false`；只保留工具：再加 `maxSummaryBytes: 0`。

## 开发

```bash
npm i                        # 或 pnpm i；装完自动跑一次 build（prepare 钩子）
npm run typecheck            # tsc --noEmit
npm test                     # 编译 + node --test
npm run smoke                # 用真实 cordis 根加载插件，检查注册结果
```

- `src/` 是 TypeScript 源；`lib/` 是**构建产物，不入库**，由 `npm run build` 生成
  （`tsc` 编译宿主半 + `scripts/build-client.mjs` 包装浏览器半）。
- `src/test/*.test.ts` 覆盖存储、检索、渲染、去重、注入时序、SQLite 状态、合并计划。
- `scripts/activation-smoke.mjs`：在真实 Cordis 上下文里加载插件，确认 `memory` 工具与
  `/memories` 命令注册成功，并验证 `enableTool` 热切换（在能解析 DSH 包的目录下运行，
  比如 profile 目录）。
- `scripts/inspect-session.mjs <session.jsonl.zstd>`：解开会话日志，看注入块和工具表。
  会话日志是**多个 zstd 帧拼接**的，必须逐帧解压。
- `scripts/seed.mjs`：往真实 `$DSH_HOME/memories` 各写一条全局与项目记忆，便于手测。

想把后台抽取的等待时间调短来手测，不要改默认值——用一个临时覆盖层：

```bash
dsh --profile web --patch ./fast.yml
# fast.yml: - id: memories / config: { autoExtractIdleMs: 1000 }
```

## 已知取舍

- 抽取是**事后**的，而且只在长驻进程里按空闲时间触发：会话刚结束就立刻关掉进程，这一轮
  不会被抽取（用 `/memories mine` 可以立刻抽一次）。
- 检索是**词法匹配**（标题/正文/tag 加权 + 使用频次 + 新近度），不是向量检索。
- 项目记忆按工作区根划分，**同一仓库的多个 clone 是两份独立记忆**（因为路径不同）。
- 摘要有字节预算，记忆很多时只会列出最相关的一部分，其余靠 `memory_search` 取。
- 抽取用的模型默认跟随该会话已记录的请求路由；如需固定路由，显式配 `extractProvider` /
  `extractModel`。
