import { Notice } from "obsidian";
import type { SedimentPlugin } from "../main";
import { t } from "../i18n";
import { dateKey, hhmm } from "../utils/dates";

export type PomodoroMode = "focus" | "short" | "long";

export interface PomodoroState {
  mode: PomodoroMode;
  remaining: number;
  running: boolean;
  completed: number;
  /** 检测到另一个存活实例时为 true，本实例番茄功能禁用。 */
  disabled: boolean;
}

/** 可注入依赖：测试用假时钟与假定时器驱动 tick。 */
export interface PomodoroDeps {
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => number;
}

const DURATION: Record<PomodoroMode, number> = {
  focus: 25 * 60,
  short: 5 * 60,
  long: 15 * 60,
};

/** 心跳写入间隔：运行/暂停都写，证明本实例存活。 */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** 心跳新鲜度阈值：60s 内有心跳视为另一实例存活。 */
const INSTANCE_ALIVE_MS = 60_000;

/**
 * 内置番茄钟：不依赖其它插件，完成后把专注分钟记进当天（实测口径），
 * 并写入会话日志。状态持久化到 data.json；计时以时间戳为基准，
 * tick 按 now - startedAt 换算剩余时间，后台节流/休眠不再漂移。
 * 到期补记归属实际到期日期，而非补记执行时的"今天"。
 * 加载时按 data.json 内的实例标识 + 心跳做单实例检测，多开时禁用本实例番茄。
 */
export class PomodoroManager {
  private mode: PomodoroMode = "focus";
  private remaining = DURATION.focus;
  private running = false;
  private completed = 0;
  /** 本段运行起点（epoch ms）；暂停时为 null。 */
  private runStartedAt: number | null = null;
  /** 本段运行开始时的剩余秒数。 */
  private runStartRemaining = DURATION.focus;
  private disabled = false;
  private lastHeartbeatAt = 0;
  private readonly instanceId: string;
  private readonly now: () => number;
  private listeners = new Set<() => void>();
  private statusEl: HTMLElement | null = null;

  constructor(private plugin: SedimentPlugin, deps: PomodoroDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.instanceId = `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.restore();
    this.statusEl = plugin.addStatusBarItem();
    this.updateStatus();
    const setIntervalFn = deps.setInterval ?? ((fn, ms) => window.setInterval(fn, ms));
    plugin.registerInterval(setIntervalFn(() => this.tick(), 1000));
  }

  /** 恢复上次状态；运行中离开的这段时间按真实流逝扣减，到期补记归属实际到期日。 */
  private restore(): void {
    const saved = this.plugin.store.data.pomodoro;
    if (!saved) return;
    if (
      saved.instanceId &&
      saved.instanceId !== this.instanceId &&
      typeof saved.heartbeatAt === "number" &&
      this.now() - saved.heartbeatAt < INSTANCE_ALIVE_MS
    ) {
      // 另一实例仍存活：不恢复、不写入，避免干扰对方计时与心跳。
      this.disabled = true;
      new Notice(t("检测到另一个实例正在使用番茄钟，本实例番茄功能已禁用"));
      return;
    }
    this.mode = saved.mode;
    this.completed = saved.completed;
    this.remaining = saved.remaining;
    this.running = saved.running;
    if (this.running) {
      // 新数据按 startedAt/startRemaining 换算；旧数据回退 savedAt/remaining。
      const startedAt = typeof saved.startedAt === "number" ? saved.startedAt : saved.savedAt;
      const startRemaining =
        typeof saved.startRemaining === "number" ? saved.startRemaining : saved.remaining;
      const elapsed = Math.max(0, Math.floor((this.now() - startedAt) / 1000));
      this.remaining = startRemaining - elapsed;
      this.runStartedAt = startedAt;
      this.runStartRemaining = startRemaining;
      if (this.remaining <= 0) {
        // 离开期间番茄已到点：补记到实际到期日并进入休息，不重复弹通知。
        this.complete(true, startedAt + startRemaining * 1000);
      }
    }
    // 接管后立即持久化本实例 instanceId + 心跳，把多开检测的接管窗口从 15s 缩到近零。
    this.persist();
  }

  /** 运行中按时间戳换算剩余秒数；暂停时 remaining 即权威值。 */
  private currentRemaining(): number {
    if (this.running && this.runStartedAt !== null) {
      return this.runStartRemaining - Math.floor((this.now() - this.runStartedAt) / 1000);
    }
    return this.remaining;
  }

  private persist(): void {
    if (this.disabled) return;
    const now = this.now();
    this.plugin.store.data.pomodoro = {
      mode: this.mode,
      remaining: Math.max(0, this.currentRemaining()),
      running: this.running,
      completed: this.completed,
      savedAt: now,
      startedAt: this.running ? this.runStartedAt : null,
      startRemaining: this.runStartRemaining,
      instanceId: this.instanceId,
      heartbeatAt: now,
    };
    this.lastHeartbeatAt = now;
    this.plugin.store.scheduleSave();
  }

  state(): PomodoroState {
    return {
      mode: this.mode,
      remaining: Math.max(0, this.currentRemaining()),
      running: this.running,
      completed: this.completed,
      disabled: this.disabled,
    };
  }

  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  start(): void {
    if (this.disabled || this.running) return;
    this.runStartedAt = this.now();
    this.runStartRemaining = this.remaining;
    this.running = true;
    this.persist();
    this.emit();
  }

  pause(): void {
    if (this.disabled) return;
    this.remaining = Math.max(0, this.currentRemaining());
    this.running = false;
    this.runStartedAt = null;
    this.persist();
    this.emit();
  }

  reset(): void {
    if (this.disabled) return;
    this.running = false;
    this.runStartedAt = null;
    this.remaining = DURATION[this.mode];
    this.persist();
    this.emit();
  }

  skip(): void {
    if (this.disabled) return;
    this.running = false;
    this.runStartedAt = null;
    this.mode = this.mode === "focus" ? (this.completed % 4 === 3 ? "long" : "short") : "focus";
    this.remaining = DURATION[this.mode];
    this.persist();
    this.emit();
  }

  toggle(): void {
    if (this.disabled) {
      new Notice(t("检测到另一个实例正在使用番茄钟，本实例番茄功能已禁用"));
      return;
    }
    if (this.running) this.pause();
    else this.start();
  }

  private tick(): void {
    if (this.disabled) return;
    if (this.running) {
      this.remaining = this.currentRemaining();
      if (this.remaining <= 0) {
        // 即使 tick 迟到（休眠/节流），也按实际到期时刻补记。
        const expiry = (this.runStartedAt ?? this.now()) + this.runStartRemaining * 1000;
        this.complete(false, expiry);
      }
      this.emit();
    }
    if (this.now() - this.lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) this.persist();
  }

  private complete(silent = false, completedAt?: number): void {
    const at = new Date(completedAt ?? this.now());
    if (this.mode === "focus") {
      this.completed += 1;
      const dayKey = dateKey(at);
      this.plugin.store.updateDay(dayKey, (day) => {
        day.focusMinutes += 25;
      });
      this.plugin.store.addFocusSession({
        date: dayKey,
        time: hhmm(at),
        mode: "focus",
        minutes: 25,
        source: "measured",
      });
      if (!silent) new Notice(t("番茄完成，已记入 25 分钟专注（实测）"));
    } else if (!silent) {
      new Notice(t("休息结束"));
    }
    this.mode = this.mode === "focus" ? (this.completed % 4 === 0 ? "long" : "short") : "focus";
    this.remaining = DURATION[this.mode];
    this.running = false;
    this.runStartedAt = null;
    this.persist();
  }

  private emit(): void {
    this.updateStatus();
    for (const listener of this.listeners) listener();
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    if (this.disabled) {
      this.statusEl.setText(t("番茄已禁用"));
      return;
    }
    const remaining = Math.max(0, this.currentRemaining());
    const minutes = String(Math.floor(remaining / 60)).padStart(2, "0");
    const seconds = String(remaining % 60).padStart(2, "0");
    const mode = this.mode === "focus" ? t("番茄") : this.mode === "short" ? t("短休") : t("长休");
    this.statusEl.setText(`${this.running ? "▶" : "⏸"} ${mode} ${minutes}:${seconds}`);
  }
}