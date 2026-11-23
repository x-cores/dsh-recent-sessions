# RecentSessions —— DSH「全部会话」主面板插件

一个 DeepSeek Harness（DSH）Web 客户端插件：为 Web GUI 增加一个「全部会话」主面板（与「上下文洞察」「技能中心」同款形态：左侧导航入口 + 主对话区面板），把所有会话集中在一个按更新时间倒序的列表里，支持搜索、分页、归档标识与按工作区整组过滤。

```
plugin/
├── package.json        # 插件清单（@local/sessions-window）
├── index.js            # host 半（无逻辑，数据全在浏览器端）
├── client.js           # browser 半（全部 UI 与数据逻辑）
├── cordis.patch.yml    # bundle patch（注册面板）
├── icon.svg            # 插件图标（内联 SVG，无外链）
└── docs/DETAIL.md      # 功能细节说明
```

## 功能

- **全量会话列表**：含归档会话，按 `updatedAt` 倒序，行首带全局序号；展示标题、工作区名、工作目录名（仅最后一段，不暴露完整路径）、相对时间 + 绝对时间。
- **状态徽标**：当前 / 置顶 / 运行中 / 已归档；已归档会话置灰且点击不跳转，其余点击直达对应对话。
- **搜索**：按标题 / 会话 ID / 路径 / 工作区名实时过滤；输入用 `useDeferredValue` 让打字保持流畅，过滤未完成时列表半透明提示；`Esc` 一键清空。
- **分页**：默认每页 20 条，可切 10 / 20 / 50 / 100，偏好持久化到 localStorage。
- **工作区过滤**：可把某些工作区（默认示例「记忆中枢」）下的全部会话整组隐藏，支持从现有工作区一键添加，过滤列表持久化。
- **主题自适应**：深 / 浅主题下原生下拉控件配色自动适配；通过 `MutationObserver` 监听主题属性变化即时生效，无轮询开销。
- **入口**：左侧导航「全部会话」行 + 输入框 dock 上的会话图标按钮。

## 数据来源

全部数据来自浏览器端官方客户端快照（`ctx.get('sessions').list` / `ctx.get('workspaces').list`），与官方侧栏同一份事实，**不经过 Host、零新增 IPC**。跳转走 `ctx.get('uiWorkspace').openSession(id)`。

## 离线 / 内网可用（硬性保证）

本插件**不引用任何互联网资源**：

- 无 CDN 脚本 / 样式，无外链字体、图标、图片；
- 所有样式为内联 React 样式 + 一段注入的内联 `<style>`；
- 所有图标（面板、空态、时钟、漏斗、入口按钮）均为内联 SVG；
- React 等运行时依赖由 DSH 客户端模块加载器本地提供；
- localStorage 存本地偏好，无任何网络请求。

可在完全无互联网的内网环境部署运行。

## 安装

```bash
dsh plugin link /path/to/RecentSessions/plugin
```

或在 Web GUI 的插件管理中 link 本地包。安装后刷新页面，左侧导航即出现「全部会话」。

## 开发与自验

无构建步骤，源码即产物。验证方式：

```bash
node --check plugin/client.js   # 语法检查
node --check plugin/index.js
```

改动后在 Web GUI 刷新页面（`pnpm run dev:web` 观察器运行时可热更客户端插件），检查：列表加载、搜索、翻页、每页条数切换、工作区过滤增删、深浅主题切换、点击跳转。

## 兼容性

- 依赖 DSH Web 客户端的 `window.__ModuleLoader__` 模块加载器与 `slots` 注入体系；
- `useDeferredValue` 不可用时自动降级为同步过滤，功能不受影响；
- `MutationObserver` 不可用时退化为 15s 低频轮询做主题探测。
