# dsh-memories

给 DeepSeek Harness 的**跨会话记忆**插件。设计参考 OpenAI Codex 的 local memories：
两套作用域、显式工具 + 后台自动抽取、分层注入摘要、详细内容按需检索。在 GUI 里，
**设置 → 记忆** 是一页式入口：浏览/搜索/新增/删除记忆、晋升技能草稿、调全部参数。

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
2. **抽取（阶段 1）** — 有两条触发路径，都用一次辅助模型调用把一段对话里**值得长期保留的事实**
   抽成记忆并写入：
   - **周期性检查**（`extractIntervalMinutes`，默认 30 分钟）：每隔这么久扫一遍所有打开的会话，
     只要有新内容、且会话当时正好空闲，就抽**一段**（水位线决定从哪儿接着抽）。这样长时间连续
     使用的会话会边用边被抽，而不是等到最后只抽一次尾巴。
   - **settle 抽取**：会话空闲到 `max(autoExtractIdleMs, minIdleHours)` 后补一次。
   子代理会话、委派深度 > 0 的会话不参与。抽出来的内容先做**密钥擦除**（`sk-…`、`ghp_…`、AKIA…、
   JWT、私钥块、`api_key=…`、`Bearer …` 等）再落盘。
   同一次调用还会返回一段**本次会话的摘要**，写成 `memories/sessions/<session-id>.md`——这就是
   记忆的**证据**：记忆说“学到了什么”，这份笔记说“当时在干什么”，判断一条记忆还成不成立时可以
   回头看它（`memory` 工具的 `evidence` 动作）。
   抽取需要进程还活着：它只在**长驻进程**（`dsh web` 这类）里触发；一次性运行
   （`dsh --profile headless "..."`）通常在计时器到点前就已退出，那一轮不会被抽取。
   想立刻抽一次用 `/memories mine`。

   > 为什么要有周期性检查：settle 抽取每次只读**最新一段**（`extractWindowMessages`），读完后水位线
   > 推到最新，所以一段几百条消息的长会话里，早于那一段的内容**再也不会被抽取**。周期检查把长会话
   > 切成若干段，每段都覆盖，这是它存在的唯一理由（没有新内容时不产生模型调用）。
   提供方因**限流或额度耗尽**拒绝时（`RATE_LIMIT` / `QUOTA`），一切后台 pass 会暂停
   `quotaCooldownMinutes`（默认 30 分钟，连续拒绝翻倍、封顶 `quotaCooldownMaxMinutes`），
   冷却期内不再发起任何后台调用；成功一次即解除。手动 `/memories mine` 也受同一闸门约束。
3. **合并重整（阶段 2）** — 阶段 1 一次只看到一个会话，无法处理**跨会话**的矛盾与碎片。
   当有新记忆落盘后，会排一个全局合并任务；冷却（`consolidateCooldownHours`，默认 6 小时）
   到期后，把一批记忆交给一个**受限子代理**：它不能写文件、不能跑命令、不能联网、不能再
   委派（`maxDepth: 1` + 工具黑名单），只能返回一份严格 JSON 的合并方案——合并重复、改写过期、
   退役失效、补上遗漏。**插件是唯一的写入者**：它校验方案里的 id 必须真实存在，然后在快照保护
   下应用；中途失败会回滚已改动的条目。想立刻合并用 `/memories consolidate`。
   「退役」是**归档**不是删除：条目被移进 `archive/`，判断错了用 `/memories restore <id>` 取回。
   每次合并的输入也不是「最近 N 条」，而是**从未复审过的优先、其余按最久未复审排序**，所以
   藏在第 200 条的老记忆也会轮到复审，不会被新记忆永远挤在门外。
   合并有**自己**的模型路由（`consolidateProvider` / `consolidateModel`）：合并比抽取更贵，可以用
   更便宜的模型；两者留空时先回退到抽取路由，再回退到会话路由。
   它还会从记忆里提炼**技能草稿**（见下）。
4. **分层注入（上下文）** — 一次会话只注入**一次**有界摘要：在第一个「有话说」的 step 进入，
   先全局、后项目，每段按 kind 分组列出标题 + 日期 + 一句话预览，整块不超过 `maxSummaryBytes`。
   「注入过没有」看的是**对话本身**，不是进程：注入的是一条持久的 user 消息，重启 dsh 后它跟着
   历史一起恢复，所以重启不会再多注一份；只有 `/compact`、清空会话（整段对话被替换）才会重新注入。
   代价是模型手里的摘要可能比记忆库旧一点，收益是一段 50 轮的会话只为记忆付一次约 2～4KB。
   摘要之外还有**按需补注**（`recallMode: on-demand`，默认）：每一轮把当前用户消息拆成句子与分句，
   分别对记忆库做一次确定性打分（和 `memory_search` 同一套公式，**不额外调用模型**），把这一轮真正
   命中的记忆合成**一个** ≤`recallMaxBytes`（默认 1200B）的 `<memory-recall>` 小块，最多
   `recallMaxPerConversation`（默认 4）条。`recallMode: once` 回到「只注一次」，`off` 完全不注入。

   **闸门有两道，因为中文只靠分数拦不住。** `recallMinScore`（默认 9）是「更严/更松」的旋钮；真正
   决定精度的是**证据闸门**：一条记忆要被补注，必须满足其一——整条提问命中标题/别名/标签/「何时有用」；
   或命中 ≥`recallMinTerms`（默认 2）个实词；或命中 1 个实词且相关度 ≥ 2×`recallMinScore`。
   其中「实词」= 长度 ≥3 的拉丁词（`dsh`、`pnpm`、`3080`），或**落在 ≥3 个连续中文字符里的 bigram**。
   这条 run 要求是踩出来的：中文没有空格，bigram 是唯一能让中文检索成立的单位，但它也是噪音来源——
   实测 54 条真实记忆里，「该插件是否有日志」与一条无关的 cost-meter 记忆只共用孤立的 `插件`，
   相关度 12，比任何「松到能召回改写提问」的下限都高。要求 bigram 落在连续 run 里，等于要求两边
   用**同一个短语**（`件的日`）而不只是同样的字。

   推论（有意接受的取舍）：记忆标题被虚词打断时（`这个插件的日志在哪里` vs `插件日志的查看方式`），
   只共用两个 2 字片段的提问**不会**触发补注——它靠开场摘要或 `memory_search` 到达。没有 IDF、
   没有分词的中文里，字节级启发式无法同时做到「召回这种改写」和「排除泛词」，插件选精度。

5. **保留与归档（定期整理）** — 记忆库不会自己变小，所以除合并之外还有一条**不花额度**的确定性
   维护线：每隔 `sweepIntervalHours`（默认 12 小时；进程启动时一次，会话空闲时再按间隔检查）
   对所有已知工作区跑一次保留判定——**这么久没有被读到、没有被注入摘要、也不是新写的**条目
   会被归档。判据只有 `maxUnusedDays`（默认 90 天）一条，结果可解释、可恢复；人手
   `/memories add` 写的条目永不自动归档。想立刻整理用 `/memories sweep`。

抽取还有三道闸门（照抄 Codex 的做法）：`minIdleHours`（会话至少空闲这么久）、
`maxAgeDays`（最后活动太久的会话永不抽取）、`maxSessionsPerPass`（一次最多处理几个会话），
用来把后台额度消耗限住。

**有效等待时间是 `max(autoExtractIdleMs, minIdleHours)`**，这一条容易看漏：定时器只在会话转入空闲时
武装一次、触发后不重排，所以若按 `autoExtractIdleMs`（默认 5 分钟）定闹钟、却要求空闲满 `minIdleHours`
才放行，那次触发必然被拒，之后再也不会有第二次——默认配置下阶段 1/2 等于从不执行。
现在定时器直接等到两个闸门都满足的时刻。两个值都支持小数（`minIdleHours: 0.5` = 半小时）。
`/memories mine` 与**进程退出兜底**不受空闲窗口限制：会话都要结束了，「它还在动」这个理由不再成立。

**周期性抽取（`extractIntervalMinutes`，默认 30 分钟）** 是主路径：每隔这么久扫一遍所有打开的会话，
只要有新内容且会话当时空闲，就抽一段（`runMaintenance` 会等一个自然的间隙，不会跟对话抢）。它
**不看静默窗口**（否则长会话期间永远轮不到），但仍受错峰与额度闸门约束；会话没有新内容时**不产生
任何模型调用**（只走一遍水位线判断）。`/memories stats` 的 `auto-extract` 行同时给出周期与 settle 等待。

**错峰（`peakHours`）**：阶段 1 抽取与阶段 2 合并是全插件仅有的两处模型调用，也就是仅有的花钱处。
`peakHours` 按**本地时间**列出「高价时段」，两个 pass 都会被推迟到窗口之外；留空则不限制。
定时器重排时**不会重置空闲计时**，所以谷时一到就立刻补跑，而不是再等一整个窗口。
手动 `/memories mine` 与 `/memories consolidate` 不受限制——那是你明确要求的调用，代价自己承担。
DeepSeek 的现价（2026-09-10 起）是**工作日 09:00-12:00 与 14:00-18:00 为峰时、峰价 = 谷价 ×2**，
其余（含整个周末、工作日午休与夜间）都是谷时，所以推荐值就是我们给的那一档：

```yaml
memories:
  peakHours: "Mon-Fri 09:00-12:00, Mon-Fri 14:00-18:00"
```

语法：`[星期] HH:MM-HH:MM`，逗号分隔多条；星期可写 `Mon-Fri`、`Mon+Wed`、`sat` 或 `*`（省略 = 每天），
窗口跨午夜也支持（`Sat 22:00-02:00`）。解析不了的条目会被忽略，并在 `/memories stats` 与日志里报出来。

`/memories stats` 里的 `auto-extract` 一行显示**有效空闲等待**，`peak-hours` 一行显示当前是否正在避峰
（`deferring for 2h` / `clear now`），`sessions: N mined / M tracked` 则区分「真正抽取完成的会话」
与「只是留下过活动记录的会话」——两者差得很多时，说明抽取根本没跑起来。

摘要内容按**统一打分**排序：`相关度 × 重要度 × 新近度衰减`。重要度来自被 `memory_search` 命中的次数，新近度按 30 天半衰期衰减但**不降到 0.25 以下**——久远但精确的记忆仍然排得进有界摘要。同一个公式也用于工具检索和按需补注，所以「值得回忆」在三处是同一个意思。

三个权重是**互相制衡**调出来的，改动前先读这三条实测教训：

- `uses` 每命中一次 +0.15、上限 5 次（原 +0.35、上限 10）。原值让重要度跨度达到 4.50×，而 11 天新库上半衰期 90 天的衰减只跨 1.06×——排序实际上等于"过去被读得最多的"，而 `uses` 只在插件开发会话里累积，于是同一批插件笔记被钉进每个不相关的会话。
- 显式来源（`tool`/`user`）加成 1.25 → 1.6：原值翻不过 3–4× 的 `uses` 差距，实测 6 条人手写的全局规则**一条都进不了**注入名单。
- 注入时若拿得到会话首个用户消息，会用现成的相关度函数给命中的记忆最高 +60% 的加权（`TOPIC_LIFT`）。没有这一项，摘要是**话题无关**的：实测同一个游戏的会话里 5/6 条全局记忆在讲 DSH 插件。

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
    logFile: ''                     # 插件自己的日志文件；默认 $DSH_HOME/logs/dsh-memories.log，留空关闭
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
| `globalSummaryEntries` | `4` | 全局段最多列出的条目数。两个作用域**共用**一份字节预算，而全局段先渲染，所以不限上限时全局会吃掉项目段用不完的部分（实测一个只有 2 条记忆的项目会话里全局占了 87%）。`0` 完全不注入全局段 |
| `globalSummaryBytes` | `1200` | 全局段**自己的字节预算**。只限条数不够：中文一条约 600 字节，4 条就占 4KB 的 60%，实测全局段仍占 45–81%；1200 ≈ 内容预算（总预算 − 约 700 字节固定框架）的三分之一，大项目会话降到 29–36%。`0` 完全不注入全局段 |
| `summaryFreshSlots` | `3` | 每个作用域预留几条给**从未被注入过**的记忆，且优先人手/模型显式写入的。作用域存满后纯按排序等于永远只展示同一批老记忆（实测 12 条上限长期钉死、66% 的条目从未被读到），新写的纠正条目永远排不进来；预留名额是**会排空的队列**：被列过一次就退出，没人排队时名额自动还给排序，所以稳态成本只有"新写的那条"。`0` 恢复纯排序 |
| `recallMode` | `on-demand` | 注入方式：`once` 只注一次摘要 / `on-demand` 额外按需补注 / `off` 只留工具 |
| `recallMinScore` | `9` | 按需补注的相关度下限。只是「更严/更松」的旋钮，精度由 `recallMinTerms` 把关；中文改写共享两个词约 9–12 分，共用一个常见词约 8 分 |
| `recallMinTerms` | `2` | 补注所需的**实词**数（长度 ≥3 的拉丁词，或落在 ≥3 连续中文字符里的 bigram）。设为 `1` 时相关度下限成为唯一闸门，中文会明显变吵 |
| `recallMaxPerConversation` | `4` | 一个会话最多补注多少**条记忆**；`0` 等于关掉按需补注 |
| `recallMaxBytes` | `1200` | 单个 `<memory-recall>` 块的字节预算；`0` 关闭按需补注 |
| `recallMinQueryChars` | `2` | 短于该字数的用户消息不触发补注判定（「好」「继续」不必扫全库） |
| `maxEntriesPerScope` | `200` | 每个作用域最多保留多少条，超出**归档**最久未使用的 |
| `maxUnusedDays` | `90` | 多久没被读到/被注入摘要/也不是新写的就归档；`0` 关闭；人手写的与置顶的永不归档 |
| `snapshotMaxAgeDays` | `60` | 标记为 `durability: snapshot` 的记忆（某个时刻的读数）从**测量那天**算起多少天后归档，与"多久没被读到"无关——过期数字再被读一次也不会变对。`0` 关闭快照过期 |
| `dedupeSimilarity` | `0.7` | 标题与正文词重叠达到该比例时，新记忆视为改写并 `supersedes` 旧记忆；`0` 只保留完全相同规则。**被替代的旧条目是归档，不是删除**（可 `restore`） |
| `sweepIntervalHours` | `12` | 定期整理间隔（对所有已知工作区）：保留策略 + 快照过期 + 作用域改名自愈 + 空目录清理 + **失效引用计数**；`0` 关闭，仍可手动 `/memories sweep` |
| `consolidateProposalMaxAgeHours` | `72` | 待确认的合并提案等多久还没被 apply/reject，后续的自动整理才可以换一份新的。窗口内后台不重复生成（生成一次是模型调用，覆盖一个没人回答的问题没有意义）；`/memories consolidate` 无视窗口。`0` 表示一直等你的答复 |
| `autoExtract` | `true` | 是否启用空闲后台抽取 |
| `autoExtractIdleMs` | `300000` | 空闲多久后开始抽取（最小 1000）；实际等待见 `minIdleHours` |
| `extractWindowMessages` | `60` | 一次抽取最多看多少条对话消息（按一个周期间隔的增量来定） |
| `extractMaxInputChars` | `48000` | 抽取输入的字符预算 |
| `extractMaxOutputTokens` | `2048` | 抽取调用的输出上限 |
| `extractTimeoutMs` | `120000` | 抽取调用超时 |
| `extractMaxMemories` | `5` | 一次抽取最多产出多少条记忆 |
| `extractIntervalMinutes` | `30` | 周期性抽取间隔（分钟，可小数）：只要有新内容且会话当时空闲就抽一段；无新内容不花调用；受错峰与额度闸门约束；`0` 关闭 |
| `minIdleHours` | `6` | 会话至少空闲这么久才可被抽取，支持小数（`0.5` = 半小时）；实际等待取它与 `autoExtractIdleMs` 的较大者 |
| `peakHours` | 空 | 本地时间的错峰规则，后台抽取/合并会推迟到窗口外；留空不限制。DeepSeek 用 `"Mon-Fri 09:00-12:00, Mon-Fri 14:00-18:00"` |
| `maxAgeDays` | `10` | 最后活动早于此天数的会话永不被抽取 |
| `maxSessionsPerPass` | `2` | 一次抽取最多处理多少个会话（新的优先） |
| `consolidate` | `true` | 是否启用阶段 2 合并重整 |
| `consolidateCooldownHours` | `6` | 两次合并之间至少间隔多少小时 |
| `consolidateMaxEntries` | `64` | 一次合并最多考虑多少条记忆 |
| `consolidateTimeoutMs` | `180000` | 一次合并子代理调用的超时 |
| `pauseOnQuotaError` | `true` | 提供方因限流/额度拒绝后，暂停一切后台 pass 直到冷却结束 |
| `quotaCooldownMinutes` | `30` | 一次拒绝后等多久；连续拒绝翻倍；`0` 等于关掉暂停 |
| `quotaCooldownMaxMinutes` | `480` | 上面那个翻倍的上限 |
| `extractProvider` / `extractModel` | 空 | 抽取调用的模型路由；留空就用该会话日志里记录的请求路由 |
| `consolidateProvider` / `consolidateModel` | 空 | 合并调用的模型路由；留空先回退到抽取路由，再回退到会话路由 |
| `enableTool` | `true` | 是否注册 `memory` 工具（改完立即生效） |
| `enableCommand` | `true` | 是否注册 `/memories` 命令（改完立即生效） |
| `logLevel` | `info` | 插件日志文件详细程度：`off`/`error`/`warn`/`info`/`debug`；`info` = 错误+警告+每轮摘要，`debug` 再加逐条决策 |
| `traceMaintenance` | `false` | 把归档、按需补注、复审选择等决策提升到 `info`（默认等级即可见）；关闭时它们只在 `debug` 出现 |

设置走 DSH 的 settings 接缝注册（`ctx.settings.register('memories', schema, …)`），
所以它自带 schema 校验、revision 冲突检测和文档热重载。若部署里没有挂
`dsh-settings-file`（没有设置文档），上面这些回退到部署层行配置里的同名扁平键；
两者都没有则用 schema 默认值。

### 设置界面

这个包还带一个**浏览器半**（`./client`，由 `dsh.client` 声明），在设置里给了**一个**入口：
**设置 → 记忆**，页内再分两个标签，内容与配置不混在一页：

- **记忆**：记忆列表（按作用域/类别过滤、关键词搜索、逐条删除）、「新增记忆」表单、待晋升的
  skill 草稿（可提升或丢弃）。项目作用域按 `overview` 报出的项目 slug 选择——**一个项目作用域
  只有在那个工作区里跑过会话之后才会出现**，界面不会凭路径凭空造出一个作用域。
- **配置**：全部 26 个可调项，标签与说明都是中文，改完立即生效。

它在**设置 → 插件 → 插件配置**里刻意**不再注册卡片**：那个列表留给主机插件，这个插件的一切
都归它自己的页面。

入口读写的是两份各自官方接缝的东西：

- 可调项走 `ctx.settingsScope.bind({ namespace: 'memories' })`，和内置设置页完全相同的 describe
  镜像 + revision 围栏写入路径，没有自建 HTTP 路由；
- 记忆数据走 **Typert 网关**：宿主 `src/remote.ts` 声明清单（`overview` / `list` / `add` /
  `forget` / `promoteSkill` / `discardSkill`）并 `provide` 出 `memories` 服务，浏览器侧挂载同一份
  清单后按 `ctx.remote.memories.*` 调用。部署里没挂网关（headless / tui）时只是没有这一页，
  模型面与命令面照旧。

清单只维护一份：`REMOTE_INVOCATION_DATA` 在宿主侧展开成带校验的 codec，构建时再序列化进浏览器包，
浏览器侧只做透传解析——校验留在真正收到值的宿主边界，浏览器包里因此不需要任何 schema 库。

## `memory` 工具

| action | 参数 | 作用 |
| --- | --- | --- |
| `write` | `scope` + `title` + `body` + `tags?` + `kind?` + `appliesTo?` | 写入或更新一条记忆（标题即身份） |
| `search` | `query?` + `scope?` + `tags?` + `limit?` | 关键词检索两个作用域；`query` 为空时按最近更新列出 |
| `read` | `id` + `scope?` | 按 id 读全文（默认先项目、后全局） |
| `forget` | `id` + `scope?` | 删除一条 |
| `evidence` | `id` 或 `evidenceSession` | 读一条记忆背后那次会话的证据笔记（当时在干什么、产出了哪些记忆） |
写项目记忆时，工具结果里会附一句提示：**如果这条事实对无关项目也成立，请同时写一份全局记忆**。

`evidence` 是给“这条记忆还成立吗”用的：注入的摘要和 `search` 只给结论，证据笔记给出当时的上下文
与时间线。没有证据笔记的会话（比如从未被挖掘过）会明确告诉你没有，而不是编一段。

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

也可以在**设置 → 记忆**页面里点「提升到技能目录」/「丢弃」——和命令走同一个服务。

晋升写出的文件就是 `@deepseek-ai/dsh-skill-filesystem` 能解析的形状（`name` + `description`
frontmatter 的目录包），下次技能目录刷新后进入目录。草稿留在原处，方便追溯来源。

## `/memories` 命令

```
/memories                     列出两个作用域
/memories list global|project 只列某一作用域
/memories search <query> [--kind <kind>]      检索，可按类别过滤
/memories show <id>           看全文
/memories add <global|project> <text> [--kind <kind>]   手工写入
/memories forget <id>         删除（真正删除；归档请用 archive）
/memories archive [global|project]   列出已归档（退役/淘汰）的记忆
/memories restore <id>        把归档的记忆取回原作用域
/memories mode [on|off]       本次会话关闭/开启记忆（不写库、不抽取、不注入）
/memories mine                立刻从当前会话抽取一次（不等空闲）
/memories consolidate         产出一次合并提案（**不改库**，等 /memories apply）
/memories plan                查看待确认的合并提案
/memories apply               落盘待确认的合并提案（失败会回滚）
/memories reject              丢弃待确认的合并提案
/memories sweep               立刻跑一次保留整理（归档长期无用的记忆）
/memories stale               列出引用了"已不存在的文件"的记忆
/memories skills              列出技能草稿
/memories promote <name>      晋升一份草稿到 $DSH_HOME/skills
/memories discard <name>      丢弃一份草稿
/memories stats               存储位置与计数
```

`kind` 取值：`fact` / `preference` / `knowledge` / `failure` / `procedure`。写错的 kind 会被忽略
而不是让过滤结果为空——手滑不该让检索静默失效。

### 三条只在需要时才会用到的记忆属性

- **`pinned`**：置顶。注入时先于预留名额与排序被选中（置顶之间仍按排序竞争，所以不会占满整段），
  并且不再因"长期未使用"被归档——置顶是人做的决定，调度无权推翻。注入行首有 📌 标记。
- **`durability: snapshot` + `asOf`**：这条记的是**某个时刻的读数**（数量、通过率、当前状态），
  不是规则。注入时带测量日期，并按 `snapshotMaxAgeDays` 从测量日算起归档。想让一条数字
  既被记住又不骗人，用这个而不是把它写成事实。
- **引用校验**：正文里写的 `dir/file.ext` 会在注入前被核对；只有当"父目录存在、文件不存在"
  时才提示「⚠ 引用的 X 已不存在，以实测为准」，并可用 `/memories stale` 全库扫描。

## 后台定期做什么（以及为什么有些事必须问你）

插件在宿主里跑三个定时任务，分工的标准只有一条：**判据是确定的、结果可逆的，就自动做；
需要模型判断并且会改写正文的，只出提案。**

| 任务 | 周期 | 做什么 | 要不要人 |
| --- | --- | --- | --- |
| 抽取（`extractIntervalMinutes`） | 30 分钟扫一遍有活动的会话（另加 `minIdleHours` 空闲门槛） | 把新内容里**可复用的事实**写进记忆；把当前作用域已有条目的标题一起给模型，让它改写已有条目而不是新增 | 不需要。写入即生效，但每条都带 provenance、可 `archive`/`forget` |
| 整理 sweep（`sweepIntervalHours`） | 12 小时 | 保留策略（`maxUnusedDays`）、快照过期（`snapshotMaxAgeDays`）、作用域改名自愈、空目录清理，并**统计失效引用条数写进一行日志** | 不需要。全部是确定性规则，且归档可 `restore` |
| 合并 consolidate（`consolidateCooldownHours`） | 6 小时冷却 | 让受限子代理把一批记忆去重、改写、退役 | **需要**：它只产出 `memories/pending/consolidation.json`，要 `/memories plan` 看、`/memories apply` 落盘、`/memories reject` 丢弃 |

为什么合并必须是提案：它是唯一会**改写正文**的通道，而它判错过——实测一次后台整理抹掉了
32 条 `appliesTo`、把 8 条人写的规则降级成"抽取器的猜测"、把中文标题改回英文，全部是事后
审计才发现的。提案有同样的能力、没有这份风险。

提案不会烂在那里：`consolidateProposalMaxAgeHours`（默认 72 小时）之内后台**不重复生成**
（避免花模型调用去覆盖一个没人回答的问题），超时后由新提案替换（届时库已经变了，旧提案本来
也不再准确）；`/memories consolidate` 无视这个窗口。注入块里会一直提示有一份待确认的提案，
`/memories stats` 的 `consolidation:` 一行会显示它的年龄与规模。

**归档 vs 删除**：归档是唯一的自动处置方式（`/memories archive` 列表、`/memories restore <id>` 取回），
永不因"长期未用"被动到 `source: user` 或 `pinned` 的记忆。真正删除只有两个入口：
`/memories forget <id>`（你明确要求），以及归档区自身的上限（每作用域保留最新 500 个归档文件）。

## 日志与排障

插件把自己说的话写进一个文件（默认 `$DSH_HOME/logs/dsh-memories.log`，超过 2MB 轮转一代，
旧的一代留在 `dsh-memories.log.1`）。文件里**只有本插件的行**，而且这是 exporter 自己保证的，
不依赖宿主的默认阈值：

```bash
tail -f ~/.dsh/logs/dsh-memories.log           # 实时看
grep '\[warn\]' ~/.dsh/logs/dsh-memories.log   # 只看警告
```

`/memories stats` 会打印当前等级与文件路径，同时也是最快的一眼诊断：store 位置、两作用域条数、
抽取/补注/保留配置与**有效抽取等待**、当前是否在**避峰**、`sessions: N mined / M tracked`、
后台是否被额度暂停、
状态库是不是降级成了纯内存、以及日志文件**打不开或写失败**时的原因。

等级含义是「该级别及以上」，所以 `off` < `error` < `warn` < `info` < `debug`。默认 `info` =
错误 + 警告 + 每轮抽取/合并摘要；`warn` 会丢掉那些摘要行，`debug` 再加上逐条决策。

**一个必须知道的宿主行为**：cordis 对每条消息**按 exporter × logger 名**过滤，阈值取
`exporter.levels?.[name] ?? exporter.levels?.default ?? logger.level ?? 1`，而 DSH 组合里唯一的
exporter（1000 条内存环形缓冲）没有声明 `levels`，于是阈值落到 `1` —— `warn`(2) 与 `debug`(3)
**在任何 sink 看到之前就被丢掉**，并且 profile 里没有任何东西读那个环形缓冲。所以本插件注册了
自己的 exporter，并在 `levels` 里同时写两个方向：`{ 'dsh-memories': 3, default: 0 }`。前者让自己
的 warn/debug 落盘；后者把**其他所有 logger** 压到 `error` —— 只写前者是不够的：exporter 是进程级
的，其他插件会被宿主的回退阈值（`1`）放进来。实测线上 `dsh-memories.log` 里那 12 行 `web-server`
的 ECONNRESET 就是这么来的（`default: 0` 之后由 `src/test/log.test.ts` 的真实 cordis 测试钉住）。
只把 profile 的 `logger.level` 调高是没用的（没有 sink 会读）。

**日志写不出去时不会静默**：文件打不开时原因记在 `/memories stats` 的 `logging:` 行；文件打开后
**写失败**也会记到同一行（`state.db` 里的运行状态），因为那个通道本身已经坏了，只能在别处报告。

想把维护决策也看清楚（为什么某条记忆被归档、为什么这一轮没补注、这次合并复审了哪些条目）：

```yaml
memories:
  logLevel: debug          # 全部打开
  traceMaintenance: true   # 或者只把决策提升到 info，不必整体开到 debug
```

补注的决策行会给出**为什么没补**：最近的候选、它的相关度、它命中了几个实词
（`needs relevance ≥9 and either 2 strong terms, one substantive term above 18, or an exact phrase`）。

其他排障入口：直接查 `state.db`（水位线 / 任务租约 / 用量与曝光计数 / 复审标记 / 额度暂停 /
上次 sweep 时间）、会话日志配 `scripts/inspect-session.mjs`（注入块是持久消息，可在历史里核实
字节数与是否重复注入）、`scripts/activation-smoke.mjs`（真实 cordis 里加载并打印注册结果）、
`npm run eval`（抽取的离线打分）。

## 离线抽取评测

改抽取 prompt 是这个插件里最危险的动作：它同时影响所有工作区，而真机跑一次要花额度。
`eval/` 下每个 JSON 是一个 fixture——一段会话、一次**真实模型的回复**、以及这次回复必须命中的
记忆清单：

```bash
npm run eval                                   # 跑 eval/ 下全部 fixture
node scripts/eval-extract.mjs --min-recall=0.8 # 低于该召回率就以退出码 1 结束
```

打分走真实的 `parseExtraction`（含密钥擦除），期望项与产出项按标题词重叠匹配，换个说法也算
命中。于是它同时给你两样东西：改 prompt 前先看回归，捕获真实回复时顺手确认没有密钥泄漏。

## 存储格式

**条目**是人类可读的 Markdown + 简单 frontmatter，**文件是唯一真相**；
**状态**（水位线、合并任务、用量计数）放在同目录的 SQLite 里。

```text
$DSH_HOME/memories/
├── index.json                     # 全局作用域索引（可重建缓存）
├── entries/<id>.md                # 每条全局记忆一个文件
├── archive/<id>.md                # 归档的全局记忆（可恢复）
├── projects/<slug>/
│   ├── index.json
│   ├── project.json               # slug 由哪个绝对路径推导而来
│   ├── entries/<id>.md
│   └── archive/<id>.md            # 该工作区归档的记忆
├── sessions/<session-id>.md        # 证据笔记：那次会话在干什么（被挖掘过的会话）
├── skills/<name>/SKILL.md         # 技能草稿（未晋升前 DSH 看不到）
├── archive/                       # 归档：退役/淘汰的记忆，可用 /memories restore 取回
└── state.db                       # SQLite：水位线 / 任务租约 / 用量与曝光计数 / 复审标记 / 额度暂停
```

条目文件：

```markdown
---
id: prefer-pnpm-over-npm
scope: global
kind: preference
title: Prefer pnpm over npm
tags: tooling, packages
keys: monorepo, workspace
appliesTo: before running any install or script
created: 2026-09-09T02:00:00.000Z
updated: 2026-09-09T02:00:00.000Z
source: tool
session: session-11111111-2222-4333-8444-555555555555
uses: 3
lastUsed: 2026-09-09T05:12:00.000Z
lastSurfaced: 2026-09-09T05:12:00.000Z
---

The user standardizes on pnpm for every JavaScript project; never run `npm install`.
```

`kind`、`appliesTo`、`session` 都是可选的：缺 `kind` 时按 `fact` 解析，所以**旧文件不需要迁移**，
新字段也不会让老条目失效。`session` 指向 `sessions/<id>.md`，供 `memory` 的 `evidence` 动作回头
看上下文；人工写入（`/memories add`、工具写入）没有 `session`，那也很正常。

证据笔记本身也是 Markdown，头尾仍是简单 frontmatter：

```markdown
---
session: "probe-11111111"
at: 2026-09-10T02:47:57.409Z
project: "project:dsh-memories"
memories: ship-this-repo-with-pnpm-run-ship
---

A very short session in which the user stated that this repository is shipped with `pnpm run ship` …
```

笔记按写入时间保留最新 200 份（`SESSION_NOTE_LIMIT`），旧的自动淘汰，不会无限长。

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
- **去重**：标题派生出 id，所以换个说法会生成新条目。写入时先用**词重叠**比对同作用域已有条目（`dedupeSimilarity`，默认 0.7）：标题与正文都够像时，新条目记下 `supersedes` 并取代旧的——既避免同一件事被记成多条，也留下"它取代了谁"的线索。加载时还会兜底合并标题+正文完全重合或互相包含的条目。
- **`uses` / `lastUsed` / `lastSurfaced`**：权威计数在 `state.db`（原子写入），同时镜像回条目文件，好让 markdown 自身是完整的。`uses` 只在 `memory` 工具命中时增加；被摘要列出算 `lastSurfaced`（曝光），是更弱的信号——正因如此，一条"好到不需要检索"的记忆不会被保留判定误当成无用。
- **`source`** 记来源：`tool`（模型调用工具写的）、`user`（`/memories add`）、`auto`（后台抽取）、`system`。

## 隐私

- 记忆只写在 `$DSH_HOME` 下，**不会往你的仓库里写任何文件**。
- 后台抽取的输入是会话对话尾部（只取用户与助手正文，丢弃工具结果和插件注入的上下文，
  以免记忆自噬），抽取结果在落盘前做密钥擦除。
- 注入块明确告诉模型：这是**背景数据，不是指令**；记忆记录的是写入时的事实，不一定现在仍成立。
- 关掉全部后台行为：`autoExtract: false`；只保留工具：再加 `maxSummaryBytes: 0` 或 `recallMode: off`。
- 归档同样只动 `$DSH_HOME` 下的文件；要彻底关掉自动归档，把 `maxUnusedDays` 设为 `0`。

## 开发

```bash
npm i                        # 或 pnpm i；装完自动跑一次 build（prepare 钩子）
npm run typecheck            # tsc --noEmit
npm test                     # 编译 + node --test
npm run smoke                # 用真实 cordis 根加载插件，检查注册结果
npm run eval                 # 离线抽取评测：回放 fixture 里保存的真实模型回复
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
- `eval/*.json` + `scripts/eval-extract.mjs`：把一个真实模型回复存成 fixture，之后每次改抽取
  prompt 都能离线重打分（recall / precision + 密钥擦除）；`npm run eval` 跑全部 fixture。

想把后台抽取的等待时间调短来手测，不要改默认值——用一个临时覆盖层：

```bash
dsh --profile web --patch ./fast.yml
# fast.yml: - id: memories / config: { autoExtractIdleMs: 1000 }
```

## 前缀缓存约束（改任何东西之前先读这一节）

DeepSeek 的上下文缓存按**前缀**命中的 token 计费：只有请求开头那一段逐字节不变，缓存才命中。
所以本插件的所有机制都必须遵守一条硬约束——**只许在消息列表尾部追加，绝不动前缀**。

三条落地规则：

1. **注入只能追加**。摘要与按需补注都通过 `agent/pre-step` 的
   `{ ...decision, messages: [...decision.messages, ...fresh] }` 追加到末尾（`src/index.ts`）。
   DSH 会 deepFreeze 请求消息列表，插件在结构上也无法改写已有消息——不要引入"改写 / 重排 / 删除历史消息"
   的做法（例如把摘要挪进 system prompt、把补注插到中间、就地更新已经注入过的那一块）。
2. **前缀里的文本改了就是全局缓存失效**：system prompt、技能目录、**工具 schema（名字 / 描述 / 参数）**。
   `memory` 工具的 schema 与提示词只在语义必须变时才动；动一次是所有会话、所有项目的缓存一起失效。
   设置项描述（`MemoriesSettingsSchema` 的 `description`）与设置页文案不在请求里，可以随便改。
3. **块内容变动不违规**。"注入哪几条记忆"每次会话都可能不同（这正是 2026-09-19 那次修复的目的：
   不再把同一批老记忆钉死），但那一块本身是**一次性写入的持久消息**，写完之后同一会话内逐字节不变，
   因此它是缓存的一部分而不是破坏者。跨会话块不同也不伤前缀：它位于该会话第一条用户消息**之后**，
   前缀在用户消息那里就已经分叉了。

改动前的自检（两句就能答完）：这次改动是否触及 system prompt / 技能目录 / 工具 schema 的文本？
是否引入任何对已有消息的改写、重排或删除？两个都答"否"才可以动代码。

## 已知取舍

- 抽取只在**长驻进程**里发生：周期检查每 `extractIntervalMinutes`（默认 30 分钟）扫一遍，
  settle 抽取要等到 `max(autoExtractIdleMs, minIdleHours)`，配了 `peakHours` 时两者都要等出谷时。
  进程退出时还有一次**兜底抽取**（不受空闲窗口限制、预算 8 秒，但同样遵守 `peakHours`），所以
  「聊完就关」通常也能被抽到；真正确保抽到的手段仍是 `/memories mine`（不受任何时间限制）。
- **一段比窗口更长的对话会丢头**：每段最多读 `extractWindowMessages` 条（默认 60）与
  `extractMaxInputChars` 个字符（默认 48000），超出的部分水位线会直接跨过去。周期检查让这种情况
  很难发生（30 分钟内一般凑不满 60 条用户/助手消息），但如果你在半小时里狂发消息，或把周期调得
  很长，就会碰到——把这两个值一起调大即可。
- **避峰会让记忆晚一点落盘**，换来的是这些调用打对折（`peakHours` 为空则不延迟）。
- 检索是**词法匹配**（标题/别名/标签/何时有用/正文加权 + 使用频次 + 新近度），不是向量检索。
- **中文检索靠字符 bigram**，所以它只认「同样的字」，不认「同样的意思」：`这个插件的日志在哪里`
  与 `插件日志的查看方式` 因为被虚词打断、只共用两个 2 字片段，按需补注**不会**触发（`memory_search`
  与开场摘要仍可到达）。补注的证据闸门要求共享 ≥3 个连续字符，这是为了挡掉「只共用 `插件`/`日志`
  这类常见词」的误补——没有 IDF 与分词，两者无法同时满足；插件选精度。
- 项目记忆按工作区根划分，**同一仓库的多个 clone 是两份独立记忆**（因为路径不同）。
- 摘要有字节预算，记忆很多时只会列出最相关的一部分，其余靠 `memory_search` 取。
- 摘要**一次会话只注入一次**：会话中途新写入的记忆不会重新出现在摘要里（只有新会话、`/compact`
  或清空会话才会重新注入），要用就 `memory_search`。「注入过」看的是对话里有没有那条 recall
  消息，所以重启 dsh 不会重置；代价是每轮要读一次会话历史（`deriveMessages` 是增量投影，很便宜）。
  注意**长会话会因压缩而重注**：每次 `/compact` 都会替换历史、让摘要再注一次，真机上长会话可
  出现「20 轮、20+ 次注入」的比例。这是刻意的——压缩后模型手里确实没有那份摘要了——但它是压缩
  次数乘以摘要字节的成本，不是"一次会话只付一次"。
- 抽取/合并的模型默认跟随该会话已记录的请求路由；如需固定路由，显式配 `extractProvider` /
  `extractModel`，合并另有 `consolidateProvider` / `consolidateModel`。
- 合并子代理**可能判定"没什么可合并的"**并原样返回，这时不会产生任何写入。这是正常的，
  不是失败——它只在新记忆确实与旧记忆冲突或重复时才动手。
- **没有任何东西是因为"老"而被删除的**：保留判定只把条目移进 `archive/`，`/memories restore <id>`
  能原样取回；真正的删除只发生在 `/memories forget` 和归档区超过 500 条上限时。
- 定期整理是**按进程时间**跑的（启动时一次 + 会话空闲时按 `sweepIntervalHours` 检查），不是
  系统级 cron：从不启动 dsh 的机器不会整理，启动即退出的脚本只能赶上启动那一次。

## 端到端验证状况

自动化测试覆盖了每个单元（211 项，含检索 eval 语料、中文 bigram 检索与证据闸门、保留判定、归档往返、状态列迁移、真机 cordis 日志路由与按需补注闸门），但提示词与真实模型行为只能靠真机跑。截至最近一次
真机验证：

| 路径 | 状态 |
| --- | --- |
| 工具写入、注入、模型真的用了记忆 | ✅ 真机 |
| 设置 → 记忆 页面（列表/搜索/范围与类别过滤/新增/删除/可调项） | ✅ 真机浏览器：真写入了 `settings.yaml`，新增的记忆当场出现在列表里并被后续注入读到；「插件 → 插件配置」里不再有重复卡片 |
| 空闲抽取（真模型） | ⚠️ 真机（但用了 `minIdleHours: 0` 覆盖层）：模型自己写了 `kind` 与 `appliesTo`。**注意**：默认配置下这条路径过去从不执行——见下一行 |
| 证据层（真模型） | ✅ 真机：SDK 驱动的真实会话被抽取后，`memories/sessions/<id>.md` 里写下了模型给的会话摘要，条目带上 `session:` 溯源；`memory action=evidence` 能读回该笔记 |
| 额度闸门 | ✅ 单元测试（含跨重启保留）；未经真实限流触发 |
| 合并子代理（真子代理） | ✅ 真机：受限子代理运行、返回结构化方案、方案被应用 |
| 技能草稿 → 晋升 → 技能目录 | ✅ 真机：晋升后冷启动会话的技能目录里出现了它（顺带查出并修掉了 description 含冒号导致草稿被静默丢弃的缺陷） |
| 注入节奏（一次会话恰好一次） | ✅ 真机进程：带插件的 headless 组合跑真实会话，注入恰好 1 次（3943 字节）；真实日志里同一进程的相邻两轮，第一轮注入、第二轮没有 |
| 重启后不重复注入 | ✅ 真实 API + 真实日志：`Session.deriveMessages()` 对注入的 recall 消息返回 `source={kind:'plugin',plugin:'memories',form:'recall'}`（判据成立），且该消息在会话日志里是普通持久事件（重启后随历史恢复） |
| 保留/归档/定期整理/按需补注/键扩展（本轮新增） | ⏳ 单元测试覆盖：保留判定、归档往返、状态列迁移、按需补注三道闸门、检索 eval 语料（hit@3 100%）与抽取 eval fixture；真机行为待下一轮复核 |
| 日志落盘（本轮新增） | ✅ 真实 cordis 激活（真服务 + 真 exporter）：`logLevel: info` 下文件里写出了启动行、`archiving global/ancient, unused for 9750 days`、`archived 1 unused memories`，归档文件带 `archived:` 时间戳；`warn`/`debug` 不再被宿主阈值丢弃由 `src/test/log.test.ts` 的真实 Context 测试钉住 |
| 抽取定时器 / 退出兜底 / 日志名过滤 / sessions 计数（缺陷修复） | ✅ 现场证据：真实库 `sessions_total=59` 而 `last_seq>0` **为 0**（阶段 1/2 从未执行），根因是 5 分钟定时器配 6 小时静默闸门且不重排；修复后定时器等到 `max(autoExtractIdleMs, minIdleHours)`、退出兜底与 `/memories mine` 绕过该闸门（均由新单测钉住）。真实 cordis 探针确认日志文件**只含本插件的行**（web-server / auto-thinking-effort 的噪音被排除）、stats 输出 `auto-extract: on (wait 6h idle …)` 与 `sessions: N mined / M tracked` |
| 错峰调度 `peakHours`（本轮新增） | ✅ 单元测试覆盖星期几/跨午夜/非法条目/延迟计算与「自动 pass 让路、手动命令不让路」（19 项 schedule 测试）。价格口径来自官方 2026-09-10 起的峰谷规则（工作日 09:00-12:00 + 14:00-18:00 峰时，峰价 = 谷价 ×2，周末全谷时）。真机行为待下一轮复核 |
| 周期性抽取 `extractIntervalMinutes`（本轮新增） | ✅ 单元测试覆盖：有新内容才抽、「无新内容不产生模型调用」、遵守峰时、定时器真的会按间隔跑、以及退出兜底在周期抽过之后仍会补抽新内容（+4 项）。现场依据：长会话只抽一次尾巴会把中间内容永久跳过（`collectWindow` 取尾部、水位线推到最新） |

> 「多轮不重注入」这一条目前是**单元测试 + 单轮真机进程**两重证据：本轮想用浏览器复核时，web
> profile 里另外几个插件把 GUI 挡住了（`dsh-message-edit` 缺 `@deepseek-ai/dsh-client-runtime/client`、
> `dsh-chat-recovery` 报 `snapshot.turnEnds is not iterable`，与本报无关），多轮浏览器复核待那些插件修好后再补。
`scripts/e2e-check.mjs` 是真机跑完后看结果的读出口；`scripts/e2e.patch.yml` 是缩短等待
时间的临时覆盖层（不入库）。
