/** 迁移后同步 Obsidian 核心「日记」插件的目录设置。
 *  核心插件 API 非公开，访问全部走类型守卫 + try/catch，失败时降级为「请手动同步」，绝不阻断迁移。 */

import { normalizeFolder } from "../utils/vault";

/** 日记插件目录读写的最小接口；纯逻辑与真实 App 解耦，便于单测。 */
export interface DailyNotesFolderAccess {
  /** 读取当前目录；不可用或读取失败返回 null。 */
  get(): string | null;
  /** 写入目录并持久化；成功返回 true。 */
  set(path: string): boolean;
}

/** 当前目录是否等于期望值（归一化后比较，容忍首尾斜杠差异）。 */
export function folderEquals(current: string | null, expected: string): boolean {
  return current !== null && normalizeFolder(current) === normalizeFolder(expected);
}

/**
 * 按期望值同步日记插件目录：
 * - 当前目录 !== expectedFrom：说明用户用的是自定义路径或未启用，跳过（不动）。
 * - 当前目录 === expectedFrom：改写为 expectedTo。
 * 返回 'changed' | 'skipped' | 'unavailable'。
 */
export function syncDailyNotesFolder(
  access: DailyNotesFolderAccess | null,
  expectedFrom: string,
  expectedTo: string
): "changed" | "skipped" | "unavailable" {
  if (!access) return "unavailable";
  const current = access.get();
  if (current === null) return "unavailable";
  if (!folderEquals(current, expectedFrom)) return "skipped";
  return access.set(expectedTo) ? "changed" : "unavailable";
}

type InternalDailyNotes = {
  enabled?: boolean;
  config?: Record<string, unknown>;
  options?: Record<string, unknown>;
  instance?: {
    options?: Record<string, unknown>;
    config?: Record<string, unknown>;
    save?: () => void;
    saveData?: (data: unknown) => void | Promise<void>;
  };
  save?: () => void;
  saveData?: (data: unknown) => void | Promise<void>;
};

interface InternalPlugins {
  plugins?: Record<string, unknown>;
  getPluginById?: (id: string) => unknown;
}

type AppWithInternal = {
  internalPlugins?: InternalPlugins;
};

function readFolder(plugin: InternalDailyNotes): string | null {
  const candidates = [
    plugin.config?.folder,
    plugin.options?.folder,
    plugin.instance?.options?.folder,
    plugin.instance?.config?.folder,
  ];
  for (const value of candidates) if (typeof value === "string") return value;
  return null;
}

/** 写入目录并尽力持久化：尝试多种非公开保存入口，任一成功即视为写入成功。 */
function writeFolder(plugin: InternalDailyNotes, path: string): boolean {
  let written = false;
  if (plugin.config && typeof plugin.config === "object") {
    plugin.config.folder = path;
    written = true;
  }
  if (plugin.options && typeof plugin.options === "object") {
    plugin.options.folder = path;
    written = true;
  }
  if (plugin.instance?.options && typeof plugin.instance.options === "object") {
    plugin.instance.options.folder = path;
    written = true;
  }
  if (plugin.instance?.config && typeof plugin.instance.config === "object") {
    plugin.instance.config.folder = path;
    written = true;
  }
  if (!written) return false;
  // 核心插件常见保存入口：wrapper.save() / instance.save() / instance.saveData(config)。
  try {
    plugin.save?.();
  } catch { /* 下一个入口重试 */ }
  try {
    plugin.instance?.save?.();
  } catch { /* 下一个入口重试 */ }
  if (plugin.instance?.saveData) {
    try {
      const data = plugin.instance.config ?? plugin.instance.options;
      if (data) void plugin.instance.saveData(data);
    } catch { /* 尽力持久化 */ }
  }
  return true;
}

/**
 * 构造真实日记插件的访问器。优先用 getPluginById，回退 plugins[id]。
 * 非公开 API 缺失或形状异常时返回 null（调用方降级为手动提醒）。
 */
export function createDailyNotesAccess(app: unknown): DailyNotesFolderAccess | null {
  const internal = (app as AppWithInternal | null)?.internalPlugins;
  if (!internal) return null;
  let plugin: InternalDailyNotes | null = null;
  try {
    const viaGet = internal.getPluginById?.("daily-notes");
    const viaMap = internal.plugins?.["daily-notes"];
    const candidate = viaGet ?? viaMap;
    if (candidate && typeof candidate === "object") plugin = candidate as InternalDailyNotes;
  } catch {
    return null;
  }
  if (!plugin || plugin.enabled === false) return null;
  const resolved = plugin;
  return {
    get() {
      try {
        return readFolder(resolved);
      } catch {
        return null;
      }
    },
    set(path: string) {
      try {
        return writeFolder(resolved, path);
      } catch {
        return false;
      }
    },
  };
}
