# AGENTS

## 项目

dsh-letterbox 是 DeepSeek Harness 的插件 bundle：`index.js` 是宿主半边（工具、提示词、认证路由、账本），`client.js` 是 Web 半边（侧栏「收件箱」入口与整页收件箱面板，外加新条目提示卡），`store.js` 是零依赖的纯状态逻辑。

## 命令

- `npm test`：跑 `test/*.test.mjs`。
- `node --check <file>`：语法自检。
- 验证五道门（全部用标准 dsh CLI 复现）：
  - G1 清单：`package.json` 声明 `dsh.bundle.patch`，且 `files` 含该 patch。
  - G2 形状：入口只有命名导出 `apply` / `name` / `inject`，没有 `export default`。
  - G3 安装：`dsh plugin --profile <tmp> add .` 后，profile 的 `dependencies` 与 `dsh.profile.bundles` 都含 `dsh-letterbox`。
  - G4 组合：`dsh --profile <tmp> --dump-config` 出现 `# == dsh-letterbox` 与 `- id: letterbox`。
  - G5 激活：`dsh --profile <tmp>` 退出码 0，且没有 `plugin tree failed to load`。
- 客户端改动用浏览器重载验证，启动梯子不覆盖这块。

## 约束

- 宿主半边保持零裸导入：`link:` 安装时裸导入从插件自身目录解析，缺依赖会直接激活失败。
- 回执只由认证路由写入；任何模型工具都不得提供「标记已读」。
- 状态文件只写 `$DSH_HOME/letterbox.json`，采用临时文件 + rename。
- 不在模块顶层做副作用；所有注册都挂 `ctx`。
- 工具名 snake_case；插件导出的 `name` 是 `letterbox`，与 patch row id 一致。