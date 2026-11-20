/** Agent 写入安全辅助：幂等键与审计脱敏。 */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

function hash(text: string): string {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16);
}

/** 相同工具、相同调用者、相同参数得到同一个键，便于去重与幂等重试。 */
export function idempotencyKey(tool: string, actor: string, payload: unknown): string {
  return hash(`${tool}\u0000${actor}\u0000${stableStringify(payload)}`);
}

/** 审计记录只保存路径，去掉查询串中的 token 等敏感参数。 */
export function redactAuditPath(path: string): string {
  return String(path ?? "").split("?")[0].split("#")[0];
}

/** 从文本中移除已知敏感串（令牌、密钥）。 */
export function redactSecrets(text: string, secrets: string[]): string {
  let result = String(text ?? "");
  for (const secret of secrets.filter((item) => item && item.length >= 4)) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}
