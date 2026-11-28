/**
 * pi-scheduled-prompts — 定时向「当前 pi 会话」注入 prompt，或定时新开一个 pi 会话执行 prompt。
 * https://github.com/hljhljhlj/pi-scheduled-prompts
 *
 * 用 /sched help 查看全部用法：
 *   /sched add 15m -- 检查一下构建状态        # 每 15 分钟把 prompt 注入本会话
 *   /sched add "0 9 * * 1-5" -- 写每日晨报     # 工作日 9 点注入（5 段 cron）
 *   /sched spawn "0 18 * * 5" -- 整理本周 changelog  # 到点新开一个 pi 会话去跑
 *   /sched list / run s1 / pause / resume / rm
 *
 * 任务保存在会话文件里（custom entry，不进模型上下文），重启 pi 后 /resume 回来继续。
 * 注入模式要求本 pi 进程保持运行（放在 Herdr 标签页里即可，关窗也在跑）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TICK_MS = 5_000; // 检查周期
const CATCH_UP_MS = 2 * 60 * 60 * 1000; // 错过超过 2 小时的触发直接跳到下一次
const ENTRY = "scheduled-prompt";

// ---------- 类型 ----------

interface CronSets {
	min: Set<number>;
	hour: Set<number>;
	dom: Set<number>;
	mon: Set<number>;
	dow: Set<number>;
	domStar: boolean;
	dowStar: boolean;
}

type Parsed = { kind: "interval"; ms: number } | { kind: "cron"; sets: CronSets } | null;

interface Sched {
	id: string;
	spec: string;
	prompt: string;
	mode: "inject" | "spawn";
	cwd: string;
	paused: boolean;
	removed: boolean;
	createdAt: number;
	nextAt: number | null;
	lastFiredAt: number | null;
	parsed?: Parsed; // 仅内存
}

// ---------- spec 解析：间隔（30s/15m/2h/1d）或 5 段 cron ----------

function parseField(field: string, min: number, max: number, map7To0 = false): Set<number> {
	const out = new Set<number>();
	for (const part of field.split(",")) {
		const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
		if (!m) throw new Error(`cron 字段无法解析: "${part}"`);
		const step = m[2] ? Number(m[2]) : 1;
		if (step < 1) throw new Error(`cron 步长必须 ≥ 1: "${part}"`);
		let lo = min;
		let hi = max;
		if (m[1] !== "*") {
			const range = m[1].split("-");
			if (range.length === 2) {
				lo = Number(range[0]);
				hi = Number(range[1]);
			} else {
				lo = hi = Number(range[0]);
			}
		}
		if (lo < min || hi > max || lo > hi) throw new Error(`cron 字段超出范围 ${min}-${max}: "${part}"`);
		for (let v = lo; v <= hi; v += step) out.add(map7To0 && v === 7 ? 0 : v);
	}
	if (out.size === 0) throw new Error(`cron 字段为空: "${field}"`);
	return out;
}

export function parseSpec(raw: string): Parsed {
	const s = raw.trim();
	const iv = /^(\d+)([smhd])$/.exec(s);
	if (iv) {
		const n = Number(iv[1]);
		const ms = n * (iv[2] === "s" ? 1000 : iv[2] === "m" ? 60_000 : iv[2] === "h" ? 3_600_000 : 86_400_000);
		if (ms < 1000) throw new Error("间隔至少 1 秒");
		return { kind: "interval", ms };
	}
	const fields = s.split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(`无法解析 "${s}"：应为 30s / 15m / 2h / 1d 间隔，或 5 段 cron（分 时 日 月 周），如 "*/10 * * * *"、"0 9 * * 1-5"`);
	}
	return {
		kind: "cron",
		sets: {
			min: parseField(fields[0], 0, 59),
			hour: parseField(fields[1], 0, 23),
			dom: parseField(fields[2], 1, 31),
			mon: parseField(fields[3], 1, 12),
			dow: parseField(fields[4], 0, 7, true), // 7 = 周日
			domStar: fields[2].trim() === "*" || fields[2].trim().startsWith("*/"),
			dowStar: fields[4].trim() === "*" || fields[4].trim().startsWith("*/"),
		},
	};
}

function cronMatches(sets: CronSets, d: Date): boolean {
	if (!sets.min.has(d.getMinutes()) || !sets.hour.has(d.getHours()) || !sets.mon.has(d.getMonth() + 1)) return false;
	const domOk = sets.dom.has(d.getDate());
	const dowOk = sets.dow.has(d.getDay());
	// vixie cron：日与周都受限时，任一匹配即可
	if (sets.domStar && sets.dowStar) return true;
	if (sets.domStar) return dowOk;
	if (sets.dowStar) return domOk;
	return domOk || dowOk;
}

function nextCron(sets: CronSets, from: number): number | null {
	const t = new Date(from);
	t.setSeconds(0, 0);
	t.setMinutes(t.getMinutes() + 1);
	const limit = 366 * 24 * 60; // 最多找一年
	for (let i = 0; i < limit; i++) {
		if (cronMatches(sets, t)) return t.getTime();
		t.setMinutes(t.getMinutes() + 1);
	}
	return null;
}

function computeNext(s: Sched, now: number): number | null {
	if (!s.parsed) s.parsed = parseSpec(s.spec);
	const p = s.parsed;
	if (!p) return null;
	if (p.kind === "interval") {
		const base = s.lastFiredAt ?? s.createdAt;
		let next = base + Math.ceil((now - base + 1) / p.ms) * p.ms;
		while (next <= now) next += p.ms;
		return next;
	}
	return nextCron(p.sets, now);
}

// ---------- 格式化 ----------

function fmtRelative(ms: number): string {
	if (ms < 0) return "现在";
	const sec = Math.round(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h${min % 60 ? ` ${min % 60}m` : ""}`;
	return `${Math.floor(hr / 24)}d`;
}

function fmtClock(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function summarize(text: string, len = 24): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > len ? `${one.slice(0, len)}…` : one;
}

// ---------- 扩展主体 ----------

export default function (pi: ExtensionAPI) {
	const schedules = new Map<string, Sched>();
	let counter = 1;
	let timer: ReturnType<typeof setInterval> | undefined;
	let liveCtx: ExtensionContext | undefined;
	let pendingPersist = false; // 会话文件尚未建立时添加过任务，首条消息落地后补写

	const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
		try {
			liveCtx?.ui.notify(msg, level);
		} catch {
			/* no UI */
		}
	};

	function persist(s: Sched) {
		// 追加一条 custom entry（不进模型上下文）；重建时同 id 最后一条生效
		pi.appendEntry(ENTRY, {
			id: s.id,
			spec: s.spec,
			prompt: s.prompt,
			mode: s.mode,
			cwd: s.cwd,
			paused: s.paused,
			removed: s.removed,
			createdAt: s.createdAt,
			nextAt: s.nextAt,
			lastFiredAt: s.lastFiredAt,
		});
		// 全新会话还没落盘时，appendEntry 只进内存：标记，首条真实消息后补写
		if (!liveCtx?.sessionManager?.getSessionFile()) pendingPersist = true;
	}

	function repersistIfNeeded(ctx: ExtensionContext) {
		if (!pendingPersist) return;
		if (!ctx.sessionManager.getSessionFile()) return;
		for (const s of schedules.values()) {
			pi.appendEntry(ENTRY, {
				id: s.id,
				spec: s.spec,
				prompt: s.prompt,
				mode: s.mode,
				cwd: s.cwd,
				paused: s.paused,
				removed: s.removed,
				createdAt: s.createdAt,
				nextAt: s.nextAt,
				lastFiredAt: s.lastFiredAt,
			});
		}
		pendingPersist = false;
	}

	function reconstruct(ctx: ExtensionContext) {
		schedules.clear();
		let maxN = 0;
		for (const raw of ctx.sessionManager.getBranch()) {
			const e = raw as { type?: string; customType?: string; data?: Partial<Sched> };
			if (e.type !== "custom" || e.customType !== ENTRY || !e.data?.id) continue;
			const d = e.data;
			if (d.removed) {
				schedules.delete(d.id);
				continue;
			}
			const s: Sched = {
				id: d.id,
				spec: d.spec ?? "",
				prompt: d.prompt ?? "",
				mode: d.mode === "spawn" ? "spawn" : "inject",
				cwd: d.cwd ?? ctx.cwd,
				paused: Boolean(d.paused),
				removed: false,
				createdAt: d.createdAt ?? Date.now(),
				nextAt: d.nextAt ?? null,
				lastFiredAt: d.lastFiredAt ?? null,
				parsed: null,
			};
			try {
				s.parsed = parseSpec(s.spec);
			} catch {
				s.paused = true; // 坏 spec：停用但不丢
			}
			schedules.set(s.id, s);
			const m = /^s(\d+)$/.exec(s.id);
			if (m) maxN = Math.max(maxN, Number(m[1]));
		}
		counter = maxN + 1;
		// 补跑/跳过错过的触发
		const now = Date.now();
		for (const s of schedules.values()) {
			if (s.paused) continue;
			if (s.nextAt == null) {
				s.nextAt = computeNext(s, now);
			} else if (s.nextAt < now && now - s.nextAt > CATCH_UP_MS) {
				s.nextAt = computeNext(s, now); // 错过太久：跳到下一次
				persist(s);
			}
			// 否则保留：首个 tick 内补触发一次（≤2h 迟到）
		}
	}

	async function fireSpawn(s: Sched) {
		// 优先在 Herdr 里开一个新标签页跑交互式 pi；不行就后台 pi --print 落日志
		try {
			const r = await pi.exec(
				"herdr-app",
				[
					"do",
					"tab.new",
					"--name",
					`⏰ ${s.id} ${summarize(s.prompt, 12)}`,
					"--folder",
					s.cwd,
					"--argv",
					JSON.stringify(["pi"]),
					"--task",
					`[scheduled ${s.id}] ${s.prompt}`,
				],
				{ timeout: 15_000 },
			);
			if (r.code === 0) {
				notify(`🚀 ${s.id}: 已在 Herdr 新标签页启动 pi`);
				return;
			}
		} catch {
			/* 没有 herdr-app，走后备 */
		}
		try {
			const logPath = join(homedir(), ".pi", "agent", `scheduled-spawn-${s.id}.log`);
			const log = openSync(logPath, "a");
			// 用本进程的 node 启动 pi 自己的入口脚本，不经过 shell：Windows 上 `pi` 是 .cmd
			// 包装器，不带 shell 启动不了；带了 shell，prompt 又要交给 cmd.exe 解析。
			// 入口拿不到时才退回裸的 `pi`（Windows 下只能走 shell）。
			const entry = process.argv[1];
			const viaEntry = !!entry && existsSync(entry);
			const prompt = `[scheduled ${s.id}] ${s.prompt}`;
			const child = viaEntry
				? spawn(process.execPath, [entry as string, "--print", prompt], {
						cwd: s.cwd,
						detached: true,
						stdio: ["ignore", log, log],
						windowsHide: true,
					})
				: spawn("pi", ["--print", prompt], {
						cwd: s.cwd,
						detached: true,
						stdio: ["ignore", log, log],
						shell: process.platform === "win32",
						windowsHide: true,
					});
			// 启动失败是异步的 error 事件：不监听就是未捕获异常，会把整个 pi 带崩。
			child.on("error", (err) => notify(`🚀 ${s.id} 启动失败: ${String(err)}`, "error"));
			child.unref();
			notify(`🚀 ${s.id}: 已后台启动 pi --print（日志 ${logPath}）`);
		} catch (err) {
			notify(`🚀 ${s.id} 启动失败: ${String(err)}`, "error");
		}
	}

	function fire(s: Sched) {
		if (s.mode === "spawn") {
			void fireSpawn(s);
			return;
		}
		const text = `[⏰ scheduled ${s.id} · ${s.spec}] ${s.prompt}`;
		const ctx = liveCtx;
		if (!ctx) return;
		try {
			if (ctx.isIdle()) {
				pi.sendUserMessage(text);
				notify(`⏰ ${s.id}: 已注入定时 prompt`);
			} else {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
				notify(`⏰ ${s.id}: 模型正忙，prompt 已排队（followUp）`);
			}
		} catch (err) {
			notify(`⏰ ${s.id} 注入失败: ${String(err)}`, "error");
		}
	}

	function updateStatus() {
		if (!liveCtx?.ui?.setStatus) return;
		try {
			if (schedules.size === 0) {
				liveCtx.ui.setStatus("sched", undefined);
				return;
			}
			const now = Date.now();
			const parts = [...schedules.values()]
				.filter((s) => !s.paused)
				.sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity))
				.slice(0, 3)
				.map((s) => `${s.id} ${s.nextAt ? fmtRelative(s.nextAt - now) : "—"}`);
			liveCtx.ui.setStatus("sched", parts.length ? `⏰ ${parts.join(" · ")}` : "⏰ 已全部暂停");
		} catch {
			/* 状态栏不可用 */
		}
	}

	function tick() {
		const now = Date.now();
		for (const s of [...schedules.values()]) {
			if (s.paused || s.removed) continue;
			if (s.nextAt == null) {
				s.nextAt = computeNext(s, now);
				continue;
			}
			if (now >= s.nextAt) {
				s.lastFiredAt = now;
				s.nextAt = computeNext(s, now);
				persist(s);
				fire(s);
			}
		}
		updateStatus();
	}

	// ---------- 命令 ----------

	const usage = [
		"⏰ /sched — 定时任务（保存在本会话里）",
		"  /sched add <spec> -- <prompt>    定时把 prompt 注入本会话",
		'  /sched spawn <spec> -- <prompt>  定时新开一个 pi 会话去跑（优先 Herdr 标签页）',
		'  spec: 30s / 15m / 2h / 1d 间隔，或 5 段 cron，如 "*/10 * * * *"、"0 9 * * 1-5"',
		"  /sched list                      查看全部与下次触发时间",
		"  /sched run <id>                  立即触发一次（测试用）",
		"  /sched pause [id|all]            暂停",
		"  /sched resume [id|all]           恢复",
		"  /sched rm <id>                   删除",
		"注：注入模式需要本 pi 进程保持运行；重启后 /resume 回来任务继续，错过超 2 小时的触发会跳过。",
	].join("\n");

	pi.registerCommand("sched", {
		description: "定时注入/触发 prompt（当前会话）",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["add ", "spawn ", "list", "run ", "pause ", "resume ", "rm ", "help"];
			const hits = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return hits.length > 0 ? hits : null;
		},
		handler: async (args, ctx) => {
			const argv = args.trim();
			liveCtx = ctx;
			if (!argv || argv === "help") {
				ctx.ui.notify(usage, "info");
				return;
			}
			const head = argv.split(/\s+/)[0];
			const restStr = argv.slice(head.length).trim();
			try {
				switch (head) {
					case "add":
					case "spawn": {
						const sep = argv.indexOf("--");
						if (sep < 0) throw new Error('缺少 "--"，用法：/sched add <spec> -- <prompt>');
						const specStr = argv.slice(head.length, sep).replace(/\s+/g, " ").trim().replace(/^"|"$/g, "");
						const prompt = argv.slice(sep + 2).trim();
						if (!specStr) throw new Error("缺少 spec（30s/15m/2h/1d 或 5 段 cron）");
						if (!prompt) throw new Error("缺少 prompt");
						const parsed = parseSpec(specStr); // 校验，出错即报
						const s: Sched = {
							id: `s${counter++}`,
							spec: specStr,
							prompt,
							mode: head === "spawn" ? "spawn" : "inject",
							cwd: ctx.cwd,
							paused: false,
							removed: false,
							createdAt: Date.now(),
							nextAt: null,
							lastFiredAt: null,
							parsed,
						};
						s.nextAt = computeNext(s, Date.now());
						schedules.set(s.id, s);
						persist(s);
						updateStatus();
						const noFile = !ctx.sessionManager.getSessionFile();
						ctx.ui.notify(
							`⏰ 已添加 ${s.id}（${s.mode === "inject" ? "注入本会话" : "新开 pi 会话"}）· 下次: ${s.nextAt ? `${fmtClock(s.nextAt)}（${fmtRelative(s.nextAt - Date.now())} 后）` : "无"}` +
								(noFile ? "\n⚠️ 本会话还没有任何消息：任务在首条消息发出前只存内存，退出会丢" : ""),
							"info",
						);
						return;
					}
					case "list": {
						if (schedules.size === 0) {
							ctx.ui.notify("（暂无定时任务，用 /sched add <spec> -- <prompt> 添加）", "info");
							return;
						}
						const now = Date.now();
						const lines = [...schedules.values()]
							.sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity))
							.map((s) => {
								const icon = s.mode === "spawn" ? "🚀" : "⏰";
								const state = s.paused ? "已暂停" : s.nextAt ? `下次 ${fmtClock(s.nextAt)}（${fmtRelative(s.nextAt - now)} 后）` : "—";
								return `${icon} ${s.id}  [${s.spec}]  ${state}\n    ${summarize(s.prompt, 48)}`;
							});
						ctx.ui.notify(lines.join("\n"), "info");
						return;
					}
					case "run": {
						const s = schedules.get(restStr);
						if (!s) throw new Error(`找不到 ${restStr || "(缺 id)"}，用 /sched list 查看`);
						fire(s);
						return;
					}
					case "pause":
					case "resume": {
						const target = restStr || "all";
						const paused = head === "pause";
						const hits = target === "all" ? [...schedules.values()] : [schedules.get(target)].filter(Boolean) as Sched[];
						if (hits.length === 0) throw new Error(`找不到 ${target}，用 /sched list 查看`);
						for (const s of hits) {
							s.paused = paused;
							if (!paused && s.nextAt != null && s.nextAt < Date.now()) s.nextAt = computeNext(s, Date.now());
							persist(s);
						}
						updateStatus();
						ctx.ui.notify(`${paused ? "已暂停" : "已恢复"}: ${hits.map((s) => s.id).join(", ")}`, "info");
						return;
					}
					case "rm": {
						const s = schedules.get(restStr);
						if (!s) throw new Error(`找不到 ${restStr || "(缺 id)"}，用 /sched list 查看`);
						s.removed = true;
						schedules.delete(s.id);
						persist(s);
						updateStatus();
						ctx.ui.notify(`已删除 ${s.id}`, "info");
						return;
					}
					default:
						ctx.ui.notify(usage, "warning");
				}
			} catch (err) {
				ctx.ui.notify(String(err instanceof Error ? err.message : err), "error");
			}
		},
	});

	// 会话里显示一条任务卡片
	pi.registerEntryRenderer(ENTRY, (entry, options, theme) => {
		const d = entry.data as Partial<Sched>;
		const icon = d.mode === "spawn" ? "🚀" : "⏰";
		let text = theme.fg("accent", `${icon} ${d.id ?? "?"}`) + theme.fg("muted", `  [${d.spec ?? ""}]`);
		if (d.removed) text += theme.fg("dim", "  (已删除)");
		else if (d.paused) text += theme.fg("warning", "  (已暂停)");
		text += "\n" + theme.fg("muted", `    ${summarize(d.prompt ?? "", 60)}`);
		if (options.expanded) {
			text +=
				theme.fg("dim", `\n    下次: ${d.nextAt ? fmtClock(d.nextAt) : "—"} · 上次: ${d.lastFiredAt ? fmtClock(d.lastFiredAt) : "—"}`) +
				theme.fg("dim", `\n    模式: ${d.mode ?? "inject"} · 目录: ${d.cwd ?? ""}`);
		}
		return new Text(text, 0, 0);
	});

	// ---------- 生命周期 ----------

	pi.on("session_start", async (_event, ctx) => {
		liveCtx = ctx;
		reconstruct(ctx);
		if (!timer) timer = setInterval(tick, TICK_MS);
		tick();
		if (schedules.size > 0 && ctx.hasUI) {
			ctx.ui.notify(`⏰ 本会话有 ${schedules.size} 个定时任务（/sched list 查看）`, "info");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		liveCtx = ctx;
		reconstruct(ctx);
		updateStatus();
	});

	// 首条真实消息落地后，补写会话建立前添加的任务
	pi.on("message_end", async (_event, ctx) => {
		repersistIfNeeded(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		liveCtx = undefined;
	});
}
