import { Notice } from "obsidian";
import type { SedimentPlugin } from "../main";

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

/** 内置番茄钟：不依赖其它插件，完成后把专注分钟记进当天。 */
export class PomodoroManager {
  private mode: PomodoroMode = "focus";
  private remaining = DURATION.focus;
  private running = false;
  private completed = 0;
  private listeners = new Set<() => void>();
  private statusEl: HTMLElement | null = null;

  constructor(private plugin: SedimentPlugin) {
    this.statusEl = plugin.addStatusBarItem();
    this.updateStatus();
    plugin.registerInterval(window.setInterval(() => this.tick(), 1000));
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
    this.emit();
  }

  pause(): void {
    this.running = false;
    this.emit();
  }

  reset(): void {
    this.running = false;
    this.remaining = DURATION[this.mode];
    this.emit();
  }

  skip(): void {
    this.running = false;
    this.mode = this.mode === "focus" ? (this.completed % 4 === 3 ? "long" : "short") : "focus";
    this.remaining = DURATION[this.mode];
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

  private complete(): void {
    if (this.mode === "focus") {
      this.completed += 1;
      this.plugin.store.updateDay(this.plugin.store.todayKey(), (day) => {
        day.focusMinutes += 25;
      });
      new Notice("番茄完成，已记入 25 分钟专注");
    } else {
      new Notice("休息结束");
    }
    this.mode = this.mode === "focus" ? (this.completed % 4 === 0 ? "long" : "short") : "focus";
    this.remaining = DURATION[this.mode];
    this.running = false;
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
