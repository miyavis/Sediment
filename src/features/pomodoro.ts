import { Notice } from "obsidian";
import type { SedimentPlugin } from "../main";
import { dateKey, hhmm } from "../utils/dates";

export type PomodoroMode = "focus" | "short" | "long";

export interface PomodoroState {
  mode: PomodoroMode;
  remaining: number;
  running: boolean;
  completed: number;
}

const DURATION: Record<PomodoroMode, number> = {
  focus: 25 * 60,
  short: 5 * 60,
  long: 15 * 60,
};

/**
 * 内置番茄钟：不依赖其它插件，完成后把专注分钟记进当天（实测口径），
 * 并写入会话日志。状态持久化到 data.json，重启 Obsidian 按时间戳推算剩余时间。
 */
export class PomodoroManager {
  private mode: PomodoroMode = "focus";
  private remaining = DURATION.focus;
  private running = false;
  private completed = 0;
  private listeners = new Set<() => void>();
  private statusEl: HTMLElement | null = null;

  constructor(private plugin: SedimentPlugin) {
    this.restore();
    this.statusEl = plugin.addStatusBarItem();
    this.updateStatus();
    plugin.registerInterval(window.setInterval(() => this.tick(), 1000));
  }

  /** 恢复上次状态；运行中离开的这段时间按真实流逝扣减。 */
  private restore(): void {
    const saved = this.plugin.store.data.pomodoro;
    if (!saved) return;
    this.mode = saved.mode;
    this.completed = saved.completed;
    this.remaining = saved.remaining;
    this.running = saved.running;
    if (this.running) {
      const elapsed = Math.max(0, Math.floor((Date.now() - saved.savedAt) / 1000));
      this.remaining -= elapsed;
      if (this.remaining <= 0) {
        // 离开期间番茄已到点：补记专注分钟并进入休息，不重复弹通知。
        this.complete(true);
      }
    }
  }

  private persist(): void {
    this.plugin.store.data.pomodoro = {
      mode: this.mode,
      remaining: this.remaining,
      running: this.running,
      completed: this.completed,
      savedAt: Date.now(),
    };
    this.plugin.store.scheduleSave();
  }

  state(): PomodoroState {
    return { mode: this.mode, remaining: this.remaining, running: this.running, completed: this.completed };
  }

  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.persist();
    this.emit();
  }

  pause(): void {
    this.running = false;
    this.persist();
    this.emit();
  }

  reset(): void {
    this.running = false;
    this.remaining = DURATION[this.mode];
    this.persist();
    this.emit();
  }

  skip(): void {
    this.running = false;
    this.mode = this.mode === "focus" ? (this.completed % 4 === 3 ? "long" : "short") : "focus";
    this.remaining = DURATION[this.mode];
    this.persist();
    this.emit();
  }

  toggle(): void {
    if (this.running) this.pause();
    else this.start();
  }

  private tick(): void {
    if (!this.running) return;
    this.remaining -= 1;
    if (this.remaining <= 0) {
      this.complete();
    }
    this.emit();
  }

  private complete(silent = false): void {
    const now = new Date();
    if (this.mode === "focus") {
      this.completed += 1;
      this.plugin.store.updateDay(this.plugin.store.todayKey(), (day) => {
        day.focusMinutes += 25;
      });
      this.plugin.store.addFocusSession({
        date: dateKey(now),
        time: hhmm(now),
        mode: "focus",
        minutes: 25,
        source: "measured",
      });
      if (!silent) new Notice("番茄完成，已记入 25 分钟专注（实测）");
    } else if (!silent) {
      new Notice("休息结束");
    }
    this.mode = this.mode === "focus" ? (this.completed % 4 === 0 ? "long" : "short") : "focus";
    this.remaining = DURATION[this.mode];
    this.running = false;
    this.persist();
  }

  private emit(): void {
    this.updateStatus();
    for (const listener of this.listeners) listener();
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    const minutes = String(Math.floor(this.remaining / 60)).padStart(2, "0");
    const seconds = String(this.remaining % 60).padStart(2, "0");
    const mode = this.mode === "focus" ? "番茄" : this.mode === "short" ? "短休" : "长休";
    this.statusEl.setText(`${this.running ? "▶" : "⏸"} ${mode} ${minutes}:${seconds}`);
  }
}