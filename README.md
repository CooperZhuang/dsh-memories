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
2. **空闲抽取（阶段 1）** — 会话空闲 `autoExtractIdleMs`（默认 5 分钟）后，用一次辅助模型
   调用把最近一段对话里**值得长期保留的事实**抽成记忆并写入。子代理会话、委派深度 > 0
   的会话不参与。抽出来的内容先做**密钥擦除**（`sk-…`、`ghp_…`、AKIA…、JWT、私钥块、
   `api_key=…`、`Bearer …` 等）再落盘。
   同一次调用还会返回一段**本次会话的摘要**，写成 `memories/sessions/<session-id>.md`——这就是
   记忆的**证据**：记忆说“学到了什么”，这份笔记说“当时在干什么”，判断一条记忆还成不成立时可以
   回头看它（`memory` 工具的 `evidence` 动作）。
   抽取需要进程还活着：它只在**长驻进程**（`dsh web` 这类）里按空闲时间触发；一次性运行
   （`dsh --profile headless "..."`）通常在空闲计时器到点前就已退出，那一轮不会被抽取。
   想立刻抽一次用 `/memories mine`。
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
   摘要之外还有**按需补注**（`recallMode: on-demand`，默认）：每一轮用当前用户消息对记忆库做一次
   确定性打分（和 `memory_search` 同一套公式，**不额外调用模型**），只有相关度够强、且这条记忆
   本会话还没出现过时，才补一个 ≤400B 的 `<memory-recall>` 小块。闸门有两道：`recallMinScore`
   与 `recallMaxPerConversation`；`recallMode: once` 回到「只注一次」，`off` 完全不注入、只留工具。

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
（默认 6 小时）才放行，那次触发必然被拒，之后再也不会有第二次——默认配置下阶段 1/2 等于从不执行。
现在定时器直接等到两个闸门都满足的时刻。`/memories mine` 与**进程退出兜底**不受空闲窗口限制：
会话都要结束了，「它还在动」这个理由不再成立。

`/memories stats` 里的 `auto-extract` 一行显示的就是这个**有效等待**，`sessions: N mined / M tracked`
则区分「真正抽取完成的会话」与「只是留下过活动记录的会话」——两者差得很多时，说明抽取根本没跑起来。

摘要内容按**统一打分**排序：`相关度 × 重要度 × 新近度衰减`。重要度来自被 `memory_search` 命中的次数，新近度按 90 天半衰期衰减但**不降到 0.25 以下**——久远但精确的记忆仍然排得进有界摘要。同一个公式也用于工具检索和按需补注，所以「值得回忆」在三处是同一个意思。

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
| `recallMode` | `on-demand` | 注入方式：`once` 只注一次摘要 / `on-demand` 额外按需补注 / `off` 只留工具 |
| `recallMinScore` | `20` | 按需补注的相关度下限（标题、别名或标签命中即可达到） |
| `recallMaxPerConversation` | `3` | 一个会话最多补注几次；`0` 等于关掉按需补注 |
| `maxEntriesPerScope` | `200` | 每个作用域最多保留多少条，超出**归档**最久未使用的 |
| `maxUnusedDays` | `90` | 多久没被读到/被注入摘要/也不是新写的就归档；`0` 关闭；人手写的永不归档 |
| `dedupeSimilarity` | `0.7` | 标题与正文词重叠达到该比例时，新记忆视为改写并 `supersedes` 旧记忆；`0` 只保留完全相同规则 |
| `sweepIntervalHours` | `12` | 定期整理间隔（对所有已知工作区）；`0` 关闭，仍可手动 `/memories sweep` |
| `autoExtract` | `true` | 是否启用空闲后台抽取 |
| `autoExtractIdleMs` | `300000` | 空闲多久后开始抽取（最小 1000）；实际等待见 `minIdleHours` |
| `extractWindowMessages` | `30` | 一次抽取最多看多少条对话消息 |
| `extractMaxInputChars` | `24000` | 抽取输入的字符预算 |
| `extractMaxOutputTokens` | `2048` | 抽取调用的输出上限 |
| `extractTimeoutMs` | `120000` | 抽取调用超时 |
| `extractMaxMemories` | `5` | 一次抽取最多产出多少条记忆 |
| `minIdleHours` | `6` | 会话至少空闲这么久才可被抽取；实际等待取它与 `autoExtractIdleMs` 的较大者 |
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
/memories consolidate         立刻合并重整全部记忆（不等冷却）
/memories sweep               立刻跑一次保留整理（归档长期无用的记忆）
/memories skills              列出技能草稿
/memories promote <name>      晋升一份草稿到 $DSH_HOME/skills
/memories discard <name>      丢弃一份草稿
/memories stats               存储位置与计数
```

`kind` 取值：`fact` / `preference` / `knowledge` / `failure` / `procedure`。写错的 kind 会被忽略
而不是让过滤结果为空——手滑不该让检索静默失效。

## 日志与排障

插件把自己说的话写进一个文件（默认 `$DSH_HOME/logs/dsh-memories.log`，超过 2MB 轮转一代，
旧的一代留在 `dsh-memories.log.1`）。文件里**只有本插件的行**：exporter 是按 logger 名过滤的，
不会把 web-server、hmr 等其他插件的噪音一起收进来：

```bash
tail -f ~/.dsh/logs/dsh-memories.log           # 实时看
grep '\[warn\]' ~/.dsh/logs/dsh-memories.log   # 只看警告
```

`/memories stats` 会打印当前等级与文件路径，同时也是最快的一眼诊断：store 位置、两作用域条数、
抽取/补注/保留配置与**有效抽取等待**、`sessions: N mined / M tracked`、后台是否被额度暂停、
状态库是不是降级成了纯内存、以及日志文件写不出来时的原因。

等级含义是「该级别及以上」，所以 `off` < `error` < `warn` < `info` < `debug`。默认 `info` =
错误 + 警告 + 每轮抽取/合并摘要；`warn` 会丢掉那些摘要行，`debug` 再加上逐条决策。

**一个必须知道的宿主行为**：cordis 对每条消息**按 exporter × logger 名**过滤，阈值取
`exporter.levels?.[name] ?? exporter.levels?.default ?? logger.level ?? 1`，而 DSH 组合里唯一的
exporter（1000 条内存环形缓冲）没有声明 `levels`，于是阈值落到 `1` —— `warn`(2) 与 `debug`(3)
**在任何 sink 看到之前就被丢掉**，并且 profile 里没有任何东西读那个环形缓冲。所以本插件注册了
自己的 exporter，并**只为自己的 logger 名**（`dsh-memories`）声明阈值 `3`：既让插件自己的
warn/debug 落盘，又不会顺手把其他插件的 debug 流量也打开。只把 profile 的 `logger.level` 调高
是没用的（没有 sink 会读）。这条由 `src/test/log.test.ts` 里的真实 cordis 测试钉住。

想把维护决策也看清楚（为什么某条记忆被归档、为什么这一轮没补注、这次合并复审了哪些条目）：

```yaml
memories:
  logLevel: debug          # 全部打开
  traceMaintenance: true   # 或者只把决策提升到 info，不必整体开到 debug
```

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

## 已知取舍

- 抽取是**事后**的，而且只在长驻进程里按空闲时间触发：会话要空闲到
  `max(autoExtractIdleMs, minIdleHours)`（默认 6 小时）才会被抽取。进程退出时还有一次
  **兜底抽取**（不受空闲窗口限制，预算 8 秒），所以「聊完就关」通常也能被抽到；真正确保抽到的
  手段仍是 `/memories mine`。
- 检索是**词法匹配**（标题/正文/tag 加权 + 使用频次 + 新近度），不是向量检索。
- 项目记忆按工作区根划分，**同一仓库的多个 clone 是两份独立记忆**（因为路径不同）。
- 摘要有字节预算，记忆很多时只会列出最相关的一部分，其余靠 `memory_search` 取。
- 摘要**一次会话只注入一次**：会话中途新写入的记忆不会重新出现在摘要里（只有新会话、`/compact`
  或清空会话才会重新注入），要用就 `memory_search`。「注入过」看的是对话里有没有那条 recall
  消息，所以重启 dsh 不会重置；代价是每轮要读一次会话历史（`deriveMessages` 是增量投影，很便宜）。
- 抽取/合并的模型默认跟随该会话已记录的请求路由；如需固定路由，显式配 `extractProvider` /
  `extractModel`，合并另有 `consolidateProvider` / `consolidateModel`。
- 合并子代理**可能判定"没什么可合并的"**并原样返回，这时不会产生任何写入。这是正常的，
  不是失败——它只在新记忆确实与旧记忆冲突或重复时才动手。
- **没有任何东西是因为"老"而被删除的**：保留判定只把条目移进 `archive/`，`/memories restore <id>`
  能原样取回；真正的删除只发生在 `/memories forget` 和归档区超过 500 条上限时。
- 定期整理是**按进程时间**跑的（启动时一次 + 会话空闲时按 `sweepIntervalHours` 检查），不是
  系统级 cron：从不启动 dsh 的机器不会整理，启动即退出的脚本只能赶上启动那一次。

## 端到端验证状况

自动化测试覆盖了每个单元（152 项，含检索 eval 语料、保留判定、归档往返、状态列迁移与按需补注闸门），但提示词与真实模型行为只能靠真机跑。截至最近一次
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
| 抽取定时器 / 退出兜底 / 日志名过滤 / sessions 计数（缺陷修复） | ✅ 现场证据：真实库 `sessions_total=59` 而 `last_seq>0` **为 0**（阶段 1/2 从未执行），根因是 5 分钟定时器配 6 小时静默闸门且不重排；修复后定时器等到 `max(autoExtractIdleMs, minIdleHours)`、退出兜底与 `/memories mine` 绕过该闸门（均由新单测钉住）。真实 cordis 探针确认日志文件**只含本插件的行**（web-server / auto-thinking-effort 的噪音被排除）、stats 输出 `auto-extract: on (mine after 6h idle …)` 与 `sessions: N mined / M tracked` |

> 「多轮不重注入」这一条目前是**单元测试 + 单轮真机进程**两重证据：本轮想用浏览器复核时，web
> profile 里另外几个插件把 GUI 挡住了（`dsh-message-edit` 缺 `@deepseek-ai/dsh-client-runtime/client`、
> `dsh-chat-recovery` 报 `snapshot.turnEnds is not iterable`，与本报无关），多轮浏览器复核待那些插件修好后再补。
`scripts/e2e-check.mjs` 是真机跑完后看结果的读出口；`scripts/e2e.patch.yml` 是缩短等待
时间的临时覆盖层（不入库）。
