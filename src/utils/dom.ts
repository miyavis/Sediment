/** 把受信任的 SVG 字符串安全地插入 DOM：不经过 innerHTML，避免审核规则与注入风险。 */
export function appendSvg(parent: HTMLElement, svg: string): SVGElement | null {
  const doc = new DOMParser().parseFromString(svg, "text/html");
  const node = doc.body.firstElementChild;
  if (!node || node.tagName.toLowerCase() !== "svg") return null;
  const imported = parent.ownerDocument.importNode(node, true);
  parent.appendChild(imported);
  return imported as unknown as SVGElement;
}

/** 清空容器后插入一张 SVG（用于横幅等需要整体替换的场景）。 */
export function setSvg(parent: HTMLElement, svg: string): void {
  parent.replaceChildren();
  appendSvg(parent, svg);
}
