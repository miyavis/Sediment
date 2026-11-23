/** Agent 工作模式的共享标签（中文源串，渲染处走 t() 翻译）。 */
export const WORK_MODES = ["readonly", "draft", "confirm", "auto"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const WORK_MODE_LABELS: Record<WorkMode, string> = {
  readonly: "只读",
  draft: "草稿",
  confirm: "确认后写入",
  auto: "自动执行",
};
