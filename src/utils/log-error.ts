import type { DiagnosticRecord } from "../types";

/** 诊断接收器：Store 满足该接口；启动早期或测试可传 null，仅打印控制台。 */
export interface DiagnosticSink {
  logDiagnostic(
    category: DiagnosticRecord["category"],
    message: string,
    detail?: string,
    schedule?: boolean
  ): void;
}

/**
 * 最小错误日志封装：console.error + 追加诊断列表（复用 Store 的带上限通道，
 * 当前上限 300 条）。不触发额外保存（schedule=false），避免持续失败时保存风暴。
 */
export function logError(
  sink: DiagnosticSink | null | undefined,
  scope: string,
  error: unknown,
  category: DiagnosticRecord["category"] = "storage"
): void {
  console.error(`Sediment: ${scope}`, error);
  const detail = error instanceof Error ? error.message : String(error);
  sink?.logDiagnostic(category, scope, detail, false);
}