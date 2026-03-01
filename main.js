const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

// ===== 修复 GPU 缓存权限问题 =====
app.commandLine.appendSwitch('disable-gpu-cache');
app.commandLine.appendSwitch('disable-software-rasterizer');

// ===== 轻量配置存储（替代 electron-store，启动速度提升 10x）=====
const DEFAULTS = {
  provider: 'zai',
  apiKey: '',
  accessToken: '',
  model: 'zai/glm-5',
  port: 3002,
  autoStart: true,
  channel: 'web',
  channelConfig: {
    wechat: { appId: '', appSecret: '', token: '' },
    telegram: { botToken: '' },
    discord: { botToken: '' },
    slack: { botToken: '', signingSecret: '' },
    dingtalk: { appKey: '', appSecret: '' },
    feishu: { appId: '', appSecret: '' }
  }
};

let configData = {};
let configPath = '';

function initConfig() {
  configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch { /* 文件损坏就用默认值 */ }
  // 合并默认值
  configData = deepMerge(DEFAULTS, configData);
}

function cfgGet(key) {
  if (!key) return configData;
  return key.split('.').reduce((obj, k) => obj?.[k], configData);
}

function cfgSet(key, value) {
  const keys = key.split('.');
  let obj = configData;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!obj[keys[i]] || typeof obj[keys[i]] !== 'object') obj[keys[i]] = {};
    obj = obj[keys[i]];
  }
  obj[keys[keys.length - 1]] = value;
  saveConfig();
}

function cfgSave(updates) {
  if (!updates || typeof updates !== 'object') return;
  configData = deepMerge(configData, updates);
  saveConfig();
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf-8');
  } catch (e) {
    console.error('Config save error:', e);
  }
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && target[key] && typeof target[key] === 'object') {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ===== 全局变量 =====
let mainWindow = null;
let tray = null;
let openclawProcess = null;
let isQuitting = false;
let gatewayToken = '';  // 每次启动生成，传给 OpenClaw 和 WebView

// ===== 资源路径工具 =====
function getResourcePath(...segments) {
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources');
  return path.join(base, ...segments);
}

function getBundledNodePath() {
  const nodePath = getResourcePath('node', 'node.exe');
  return fs.existsSync(nodePath) ? nodePath : 'node';
}

function getOpenClawEntry() {
  const entry = getResourcePath('openclaw', 'openclaw.mjs');
  return fs.existsSync(entry) ? entry : null;
}

function readOpenClawConfig() {
  const candidates = [
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'openclaw.json'),
    path.join(app.getPath('home'), '.openclaw', 'openclaw.json')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      }
    } catch { /* ignore */ }
  }
  return null;
}

// ===== 窗口创建 =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    backgroundColor: '#0f0f17',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false
  });

  mainWindow.loadFile('index.html');

  // 窗口准备好立刻显示，不等任何异步操作
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 窗口显示后再自动启动服务（不阻塞窗口渲染）
  mainWindow.webContents.once('did-finish-load', () => {
    if (cfgGet('autoStart')) {
      setTimeout(() => startOpenClaw(), 200);
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ===== 系统托盘 =====
function createTray() {
  let trayIcon;
  const trayPath = path.join(__dirname, 'assets', 'tray.png');
  if (fs.existsSync(trayPath)) {
    trayIcon = nativeImage.createFromPath(trayPath);
  } else {
    trayIcon = nativeImage.createFromBuffer(
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAARElEQVQ4T2N0cPj/n4EBCBgZGRkZQGwGBgYGJhAbxIaxQWImkBgKG6SAkQFEg2gUA0AGEOsCZBfgnQ5IXIDLBQS9AACqXBIRHfHRnAAAAABJRU5ErkJggg==', 'base64')
    );
  }
  tray = new Tray(trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: '启动服务', click: () => startOpenClaw() },
    { label: '停止服务', click: () => stopOpenClaw() },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; stopOpenClaw(); app.quit(); } }
  ]);

  tray.setToolTip('OpenClaw Launcher');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ===== 端口清理（Windows 兼容）=====
function killProcessOnPort(port) {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf-8', timeout: 5000 });
      const pids = new Set(out.split('\n').map(l => l.trim().split(/\s+/).pop()).filter(p => p && /^\d+$/.test(p)));
      for (const pid of pids) {
        try { execSync(`taskkill /PID ${pid} /F /T`, { timeout: 5000 }); } catch { /* already dead */ }
      }
    } else {
      execSync(`lsof -ti:${port} | xargs -r kill -9`, { timeout: 5000 });
    }
  } catch { /* no process on port — fine */ }
}

// ===== OpenClaw 进程管理 =====
function startOpenClaw() {
  if (openclawProcess) {
    sendLog('warn', 'OpenClaw 已在运行');
    return;
  }

  const apiKey = cfgGet('apiKey') || '';
  const provider = cfgGet('provider') || 'zai';
  const port = cfgGet('port') || 3002;
  const env = { ...process.env };

  // 注入 API Key
  if (apiKey) {
    const envMap = { zai: 'ZAI_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
    if (envMap[provider]) env[envMap[provider]] = apiKey;
  }

  // ===== Gateway 认证策略 =====
  // 优先级: Launcher accessToken > OpenClaw 配置文件 gateway.auth.token > 无认证
  const accessToken = (cfgGet('accessToken') || '').trim();
  const ocConfig = readOpenClawConfig();
  const ocToken = ocConfig?.gateway?.auth?.token || '';
  gatewayToken = accessToken || ocToken;
  const useTokenAuth = gatewayToken.length > 0;
  if (useTokenAuth) env.OPENCLAW_GATEWAY_TOKEN = gatewayToken;
  else delete env.OPENCLAW_GATEWAY_TOKEN;

  // 注入 Channel 配置
  const channel = cfgGet('channel') || 'web';
  const channelCfg = cfgGet('channelConfig') || {};
  env.OPENCLAW_CHANNEL = channel;

  const channelEnvMap = {
    wechat: { appId: 'WECHAT_APP_ID', appSecret: 'WECHAT_APP_SECRET', token: 'WECHAT_TOKEN' },
    telegram: { botToken: 'TELEGRAM_BOT_TOKEN' },
    discord: { botToken: 'DISCORD_BOT_TOKEN' },
    slack: { botToken: 'SLACK_BOT_TOKEN', signingSecret: 'SLACK_SIGNING_SECRET' },
    dingtalk: { appKey: 'DINGTALK_APP_KEY', appSecret: 'DINGTALK_APP_SECRET' },
    feishu: { appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET' }
  };

  if (channelEnvMap[channel] && channelCfg[channel]) {
    for (const [field, envKey] of Object.entries(channelEnvMap[channel])) {
      if (channelCfg[channel][field]) env[envKey] = channelCfg[channel][field];
    }
  }

  sendLog('info', `正在启动 OpenClaw (端口 ${port}, 频道 ${channel}, 认证 ${useTokenAuth ? 'token' : 'none'})...`);
  sendStatus('starting');

  killProcessOnPort(port);

  const openclawEntry = getOpenClawEntry();
  const nodeBin = getBundledNodePath();
  const gatewayArgs = ['gateway', '--port', String(port)];
  if (useTokenAuth) {
    gatewayArgs.push('--auth', 'token', '--token', gatewayToken);
  } else {
    gatewayArgs.push('--auth', 'none');
  }

  try {
    if (openclawEntry) {
      sendLog('info', `使用内嵌运行时`);
      openclawProcess = spawn(nodeBin, [openclawEntry, ...gatewayArgs], {
        env,
        cwd: path.dirname(openclawEntry),
        windowsHide: true
      });
    } else {
      sendLog('info', '使用系统全局 openclaw');
      const cmd = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
      openclawProcess = spawn(cmd, gatewayArgs, {
        env,
        shell: true,
        windowsHide: true
      });
    }

    openclawProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) sendLog('info', msg);
    });

    openclawProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) sendLog('error', msg);
    });

    openclawProcess.on('error', (err) => {
      sendLog('error', `启动失败: ${err.message}`);
      sendStatus('stopped');
      openclawProcess = null;
    });

    openclawProcess.on('close', (code) => {
      sendLog('info', `OpenClaw 进程退出 (code: ${code})`);
      sendStatus('stopped');
      openclawProcess = null;
    });

    pollServiceReady(port, 45);

  } catch (error) {
    sendLog('error', `启动异常: ${error.message}`);
    sendStatus('stopped');
    openclawProcess = null;
  }
}

function pollServiceReady(port, retries, attempt = 0) {
  if (!openclawProcess) return; // 进程已退出，停止轮询

  if (retries <= 0) {
    sendStatus('running');
    sendLog('warn', `轮询超时，但服务进程仍在运行 → http://127.0.0.1:${port}/`);
    sendToRenderer('openclaw:ready', { port, token: gatewayToken });
    return;
  }

  const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
    // 消费响应数据，避免内存泄漏
    res.resume();

    if (res.statusCode >= 200 && res.statusCode < 400) {
      // 2xx/3xx → 服务就绪
      sendStatus('running');
      sendLog('success', `OpenClaw 服务就绪 ✓ → http://127.0.0.1:${port}/`);
      sendToRenderer('openclaw:ready', { port, token: gatewayToken });
    } else if (res.statusCode === 401 || res.statusCode === 403) {
      // 认证错误 → 服务已启动，但需要 token
      sendStatus('running');
      sendLog('warn', `服务已启动但返回 ${res.statusCode}，尝试直接加载...`);
      sendToRenderer('openclaw:ready', { port, token: gatewayToken });
    } else {
      // 其他错误码 → 重试
      sendLog('info', `服务返回 ${res.statusCode}，等待就绪...`);
      const delay = Math.min(1000 * Math.pow(1.3, attempt), 5000);
      setTimeout(() => pollServiceReady(port, retries - 1, attempt + 1), delay);
    }
  });

  req.on('error', () => {
    // 连接失败 → 服务还没起来
    const delay = Math.min(1000 * Math.pow(1.3, attempt), 5000);
    setTimeout(() => pollServiceReady(port, retries - 1, attempt + 1), delay);
  });

  req.setTimeout(3000, () => {
    req.destroy();
    const delay = Math.min(1000 * Math.pow(1.3, attempt), 5000);
    setTimeout(() => pollServiceReady(port, retries - 1, attempt + 1), delay);
  });
}

function stopOpenClaw() {
  if (!openclawProcess) {
    sendLog('warn', 'OpenClaw 未运行');
    return;
  }

  sendLog('info', '正在停止 OpenClaw...');
  sendStatus('stopping');

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(openclawProcess.pid), '/f', '/t'], { shell: true });
  } else {
    openclawProcess.kill('SIGTERM');
  }

  openclawProcess = null;
  sendStatus('stopped');
  sendLog('info', 'OpenClaw 已停止');
}

function sendLog(type, message) {
  sendToRenderer('openclaw:log', { type, message });
}

function sendStatus(status) {
  sendToRenderer('openclaw:status', status);
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ===== IPC =====
function setupIPC() {
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.on('window:close', () => mainWindow?.close());

  ipcMain.handle('openclaw:start', () => { startOpenClaw(); return true; });
  ipcMain.handle('openclaw:stop', () => { stopOpenClaw(); return true; });
  ipcMain.handle('openclaw:status', () => openclawProcess ? 'running' : 'stopped');

  ipcMain.handle('config:get', (_, key) => cfgGet(key));
  ipcMain.handle('config:set', (_, key, value) => { cfgSet(key, value); return true; });
  ipcMain.handle('config:getAll', () => configData);
  ipcMain.handle('config:save', (_, cfg) => { cfgSave(cfg); return true; });

  ipcMain.handle('runtime:check', () => {
    const nodePath = getBundledNodePath();
    const openclawEntry = getOpenClawEntry();
    const nodeExists = nodePath !== 'node' && fs.existsSync(nodePath);
    return {
      bundled: nodeExists && !!openclawEntry,
      nodePath: nodeExists ? nodePath : '系统全局',
      openclawPath: openclawEntry || '系统全局'
    };
  });
}

// ===== App Lifecycle =====
app.whenReady().then(() => {
  initConfig();      // 同步读 JSON，< 1ms
  createWindow();    // 立刻创建窗口
  createTray();
  setupIPC();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopOpenClaw();
    app.quit();
  }
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
  else mainWindow.show();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopOpenClaw();
});
