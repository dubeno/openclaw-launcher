# OpenClaw Launcher

零依赖桌面启动器 —— 一键运行 [OpenClaw](https://openclaw.ai) AI 代理网关。

打包后的应用内嵌 Node.js 运行时和 OpenClaw 完整运行时，**用户无需安装任何环境**，解压即用。

## 功能

- 内嵌 Node.js + OpenClaw 运行时，开箱即用
- 自动读取 `~/.openclaw/openclaw.json` 的 Gateway Token，WebView 免手动认证
- 支持任意模型（`provider/model` 自由输入），不限提供商
- 多频道接入：Web UI / 微信 / Telegram / Discord / Slack / 钉钉 / 飞书
- 自定义无边框窗口 + 系统托盘常驻
- Windows / macOS / Linux 跨平台

## 项目结构

```
openclaw-launcher/
├── main.js                    # Electron 主进程
├── preload.js                 # 安全桥接（主进程 ↔ 渲染进程）
├── renderer.js                # 渲染进程逻辑
├── index.html                 # UI 布局
├── styles.css                 # 样式
├── assets/                    # 图标资源
├── scripts/
│   └── bundle-runtime.js      # 打包运行时到 resources/
├── resources/                 # (gitignore) 打包时生成
│   ├── node/                  #   内嵌的 Node.js
│   └── openclaw/              #   内嵌的 OpenClaw 运行时
├── dist/                      # (gitignore) 构建产物
├── package.json
└── .gitignore
```

## 开发

### 前置要求

| 依赖 | 最低版本 | 说明 |
|------|---------|------|
| [Node.js](https://nodejs.org/) | >= 22.12.0 | OpenClaw 运行时要求 |
| npm | 随 Node.js | 包管理 |
| [OpenClaw](https://www.npmjs.com/package/openclaw) | 最新 | 全局安装，用于打包内嵌 |

### 环境搭建

```bash
# 1. 克隆仓库
git clone https://github.com/dubeno/openclaw-launcher.git
cd openclaw-launcher

# 2. 安装开发依赖（Electron + electron-builder）
npm install

# 3. 全局安装 OpenClaw（仅开发/打包时需要，用户不需要）
npm install -g openclaw

# 4. 将 Node.js 和 OpenClaw 运行时复制到 resources/
npm run bundle
```

### 启动（开发模式）

```bash
# 直接启动 Electron（使用 resources/ 中的内嵌运行时）
npm start

# 或带开发标志
npm run dev
```

启动后 Launcher 会自动在 `http://127.0.0.1:3002` 运行 OpenClaw Gateway，并在内嵌 WebView 中加载 Dashboard。

### 配置文件

| 配置 | 路径 | 说明 |
|------|------|------|
| Launcher 配置 | `%APPDATA%/openclaw-launcher/config.json` | 模型、端口、API Key、频道等 |
| OpenClaw 配置 | `~/.openclaw/openclaw.json` | Gateway 认证 token、模型定义等 |

Launcher 会自动从 OpenClaw 配置中读取 `gateway.auth.token`，无需手动复制粘贴。

## 打包发布

### Windows

```bash
npm run build:win
```

产物在 `dist/` 目录：
- `dist/win-unpacked/` — 免安装便携版（可直接压缩分发）
- `dist/OpenClaw Launcher Setup *.exe` — NSIS 一键安装包

> **注意**：Windows 打包需要管理员权限或开启开发者模式（Settings → Developer Settings → Developer Mode），否则 winCodeSign 解压会因符号链接权限失败。遇到此问题可直接使用 `dist/win-unpacked/` 便携版。

### macOS / Linux

```bash
npm run build:mac    # 生成 .dmg
npm run build:linux  # 生成 .AppImage
```

### 便携版 ZIP（推荐分发方式）

```bash
# 先打包
npm run build:win

# 再压缩（用项目自带的 7zip）
node_modules/7zip-bin/win/x64/7za.exe a -tzip dist/OpenClaw-Launcher-win-x64.zip ./dist/win-unpacked/*
```

## 更新 OpenClaw 运行时

当 OpenClaw 发布新版本时：

```bash
# 1. 更新全局 OpenClaw
npm update -g openclaw

# 2. 重新打包运行时
npm run bundle

# 3. 重新构建
npm run build:win
```

`bundle-runtime.js` 会自动将最新版本的 OpenClaw 复制到 `resources/openclaw/`。

如果只是开发调试（不打包），更新后直接 `npm start` 即可使用新版运行时。

## 给用户的使用说明

### 系统要求

- Windows 10/11 x64
- 可能需要 [Visual C++ Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe)（大多数系统已自带）

### 首次使用

1. 解压 ZIP 或运行安装包
2. 双击 `OpenClaw Launcher.exe`
3. 点击右上角 ⚙️ 设置，填入 **API Key**（如 [Z.AI 智谱](https://open.bigmodel.cn/) 的密钥）
4. 点击 **保存配置** → **启动**
5. Dashboard 加载完成后即可开始对话

### 模型配置

模型 ID 格式为 `provider/model`，支持任意提供商，常见示例：

| 提供商 | 模型 ID 示例 |
|--------|-------------|
| Z.AI (智谱) | `zai/glm-5`、`zai/glm-4.7`、`zai/glm-4.7-flash` |
| OpenAI | `openai/gpt-4o`、`openai/o3-mini` |
| Anthropic | `anthropic/claude-4-opus`、`anthropic/claude-4-sonnet` |
| DeepSeek | `deepseek/deepseek-chat`、`deepseek/deepseek-reasoner` |
| Moonshot | `moonshot/moonshot-v1-auto` |
| MiniMax | `minimax/abab7-chat` |

输入框支持自由输入，也可从下拉列表选择常用模型。

## License

MIT
