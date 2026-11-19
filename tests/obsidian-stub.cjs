/**
 * 测试用 obsidian 桩模块（Pulsewright 思路）：
 * 让导入了 obsidian 的源码模块能在 Node 里被 require，从而对纯函数做单测。
 * 只提供模块加载/纯函数路径上用到的最小表面，UI 类均为无操作占位。
 */
class TFile {
  constructor(path = "") {
    this.path = path;
    this.basename = path.split("/").pop()?.replace(/\.md$/, "") ?? "";
    this.name = path.split("/").pop() ?? "";
    this.parent = null;
    this.stat = { ctime: 0, mtime: 0, size: 0 };
  }
}
class TFolder {
  constructor(path = "") {
    this.path = path;
    this.children = [];
  }
}
class Notice {
  constructor(_message) {}
  setMessage() { return this; }
  hide() {}
}
class Component {
  load() {}
  unload() {}
  register() {}
  registerEvent() {}
  registerInterval() {}
}
class Plugin extends Component {}
class ItemView extends Component {
  constructor(leaf) { super(); this.leaf = leaf; this.contentEl = {}; }
}
class Modal extends Component {
  constructor(app) { super(); this.app = app; this.contentEl = {}; }
  open() {}
  close() {}
}
class PluginSettingTab extends Component {
  constructor(app, plugin) { super(); this.app = app; this.plugin = plugin; this.containerEl = {}; }
}
class Setting {
  constructor() {}
  setName() { return this; }
  setDesc() { return this; }
  addText() { return this; }
  addToggle() { return this; }
  addDropdown() { return this; }
  addButton() { return this; }
}
class WorkspaceLeaf {}
class WorkspaceSidedock {}
const MarkdownRenderer = { render: async () => {} };
function normalizePath(path) { return String(path).replace(/([\\/])+/g, "/").replace(/(^\/|\/$)/g, ""); }
const moment = () => ({ format: () => "" });
moment.locale = () => "zh";
const Platform = { isMobile: false, isDesktop: true };

module.exports = {
  TFile,
  TFolder,
  Notice,
  Component,
  Plugin,
  ItemView,
  Modal,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  WorkspaceSidedock,
  MarkdownRenderer,
  normalizePath,
  moment,
  Platform,
};