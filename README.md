# pi-scheduled-prompts

⏰ pi 的定时任务扩展：把 prompt **定时注入到正在进行的 pi 会话**，或**定时新开一个 pi 会话**去执行。

```text
/sched add 15m -- 检查一下构建状态              # 每 15 分钟注入本会话
/sched add "0 9 * * 1-5" -- 写每日晨报           # 工作日 9:00 注入（5 段 cron）
/sched spawn "0 18 * * 5" -- 整理本周 changelog  # 周五 18:00 新开一个 pi 会话去跑
```

## 为什么是 pi 扩展而不是外部调度器

往一个**进行中的对话**里插 prompt，只有 pi 进程自己能干净地做到（`sendUserMessage`）：
正确进会话树、模型忙时自动排 followUp 队列、不打扰你正在输入的草稿。
外部工具（herdr / tmux / 终端注入）只能往终端里打字，会和你正在编辑的文本冲突。

跨进程的定时（pi 没开也照跑）适合系统级调度器（如 [herdr-automations](https://github.com/DnzzL/herdr-automations)）；两者互补，不冲突。

## 功能

- **inject 模式**：到点把 prompt 作为真实 user 消息注入本会话；模型空闲立即执行，忙碌则排队（followUp）
- **spawn 模式**：到点新开会话执行——优先在 [Herdr](https://herdr.dev) 开一个新标签页跑交互式 pi（`herdr-app do tab.new`），没有 Herdr 则后台 `pi --print` 落日志到 `~/.pi/agent/scheduled-spawn-<id>.log`
- **spec**：`30s` / `15m` / `2h` / `1d` 间隔，或 5 段 cron（分 时 日 月 周，支持 `*` `*/n` `a-b` 列表，vixie 日/周语义）
- **持久化**：任务存在会话文件里（custom entry，不进模型上下文），`/resume` 回来继续；错过 ≤2h 的触发自动补跑一次，更久的跳到下一次
- **状态栏**：底部显示最近几个任务的倒计时
- 零依赖，单个 TypeScript 文件

## 安装

```bash
# 方式一：从 GitHub 安装
pi install git:github.com/xiaolikt/pi-scheduled-prompts

# 方式二：本地开发（clone 后指向源文件，改完 /reload 即生效）
git clone https://github.com/xiaolikt/pi-scheduled-prompts ~/Project/pi-scheduled-prompts
# 然后在 ~/.pi/agent/settings.json 的 "extensions" 数组里加入：
#   "/home/you/Project/pi-scheduled-prompts/scheduled-prompts.ts"
```

## 用法

`/sched` 或 `/sched help` 查看全部命令：

| 命令 | 作用 |
|---|---|
| `/sched add <spec> -- <prompt>` | 添加：定时注入**本会话** |
| `/sched spawn <spec> -- <prompt>` | 添加：定时**新开** pi 会话执行 |
| `/sched list` | 列出全部任务与下次触发时间 |
| `/sched run <id>` | 立即触发一次（测试） |
| `/sched pause [id\|all]` / `resume` | 暂停 / 恢复 |
| `/sched rm <id>` | 删除 |

注入的消息带 `[⏰ scheduled s1 · 15m]` 前缀，便于在对话里辨认来源。

## 设计要点

- **注入原语**：`pi.sendUserMessage()`——idle 时直接开一轮，streaming 时 `deliverAs: "followUp"` 排队；不走终端模拟
- **持久化**：`pi.appendEntry()` 写 custom entry（不进 LLM 上下文），`session_start` / `session_tree` 时从当前分支重建（同 id 最后一条生效，`removed` 为墓碑）
- **补跑窗口**：默认 2 小时（`CATCH_UP_MS`）。pi 进程不在时不会触发；放 Herdr 标签页里进程常驻，关窗也照跑
- **spawn 回退链**：`herdr-app do tab.new --argv '["pi"]' --task …` → 失败则 `detached pi --print` + 日志文件

## Roadmap

- [ ] LLM 工具：让模型自己创建/管理定时任务（`scheduled_prompts_create` 等）
- [ ] 每任务可选 `deliverAs`（steer / followUp）
- [ ] 6 段 cron + 秒级 / RRULE 子集
- [ ] spawn 模式可选 worktree 隔离、运行历史
- [ ] 单元测试（cron 解析与 nextOccurrence）

## License

MIT
