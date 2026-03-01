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

function getOpenClawHome() {
  return path.join(process.env.USERPROFILE || process.env.HOME || app.getPath('home'), '.openclaw');
}

function readOpenClawConfig() {
  const configPath = path.join(getOpenClawHome(), 'openclaw.json');
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

function ensureOpenClawConfig(provider, model, apiKey, port) {
  const ocHome = getOpenClawHome();
  const configPath = path.join(ocHome, 'openclaw.json');

  const providerBaseUrls = {
    zai: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions' },
    openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-completions' },
    anthropic: { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' },
    google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-gemini' },
    xai: { baseUrl: 'https://api.x.ai/v1', api: 'openai-completions' },
    mistral: { baseUrl: 'https://api.mistral.ai/v1', api: 'openai-completions' },
    minimax: { baseUrl: 'https://api.minimax.chat/v1', api: 'openai-completions' },
    'minimax-cn': { baseUrl: 'https://api.minimax.chat/v1', api: 'openai-completions' },
    groq: { baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-completions' },
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions' },
    'openai-codex': { baseUrl: 'https://api.openai.com/v1', api: 'openai-completions' },
  };

  const providerEnvKeys = {
    zai: 'ZAI_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY', xai: 'XAI_API_KEY', mistral: 'MISTRAL_API_KEY',
    minimax: 'MINIMAX_API_KEY', 'minimax-cn': 'MINIMAX_API_KEY',
    groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY', 'openai-codex': 'OPENAI_API_KEY',
  };

  let existing = readOpenClawConfig();
  let needsWrite = false;

  if (!existing) {
    fs.mkdirSync(ocHome, { recursive: true });
    existing = {};
    needsWrite = true;
  }

  if (!existing.gateway || existing.gateway.mode !== 'local') {
    existing.gateway = deepMerge(existing.gateway || {}, {
      port: port || 3002,
      mode: 'local',
      bind: 'loopback'
    });
    needsWrite = true;
  }

  if (model && (!existing.agents?.defaults?.model?.primary || needsWrite)) {
    existing.agents = deepMerge(existing.agents || {}, {
      defaults: { model: { primary: model } }
    });
    needsWrite = true;
  }

  if (provider && providerBaseUrls[provider]) {
    const pCfg = providerBaseUrls[provider];
    if (!existing.models?.providers?.[provider]) {
      existing.models = deepMerge(existing.models || {}, {
        providers: { [provider]: pCfg }
      });
      needsWrite = true;
    }
  }

  if (apiKey && provider) {
    const profileKey = `${provider}:default`;
    if (!existing.auth?.profiles?.[profileKey]) {
      existing.auth = deepMerge(existing.auth || {}, {
        profiles: { [profileKey]: { provider, mode: 'api_key' } }
      });
      needsWrite = true;
    }

    const agentDir = path.join(ocHome, 'agents', 'main', 'agent');
    const authFile = path.join(agentDir, 'auth-profiles.json');
    try {
      let authProfiles = {};
      if (fs.existsSync(authFile)) {
        authProfiles = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
      }
      const envKey = providerEnvKeys[provider] || `${provider.toUpperCase()}_API_KEY`;
      if (!authProfiles[profileKey]) {
        fs.mkdirSync(agentDir, { recursive: true });
        authProfiles[profileKey] = { apiKey, envKey };
        fs.writeFileSync(authFile, JSON.stringify(authProfiles, null, 2), 'utf-8');
      }
    } catch (e) {
      console.error('Auth profiles write error:', e);
    }
  }

  if (needsWrite) {
    try {
      fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');
    } catch (e) {
      console.error('OpenClaw config write error:', e);
    }
  }

  return existing;
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
    const hideOpts = { encoding: 'utf-8', timeout: 5000, windowsHide: true, stdio: 'pipe' };
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, hideOpts);
      const pids = new Set(out.split('\n').map(l => l.trim().split(/\s+/).pop()).filter(p => p && /^\d+$/.test(p)));
      for (const pid of pids) {
        try { execSync(`taskkill /PID ${pid} /F /T`, hideOpts); } catch { /* already dead */ }
      }
    } else {
      execSync(`lsof -ti:${port} | xargs -r kill -9`, hideOpts);
    }
  } catch { /* no process on port — fine */ }
}

// ===== OpenClaw onboard 核心逻辑 =====
const AUTH_KEY_MAP = {
  zai: '--zai-api-key', openai: '--openai-api-key', anthropic: '--anthropic-api-key',
  google: '--custom-api-key', xai: '--custom-api-key', mistral: '--custom-api-key',
  minimax: '--custom-api-key', 'minimax-cn': '--custom-api-key',
  groq: '--custom-api-key', openrouter: '--custom-api-key', 'openai-codex': '--openai-api-key',
};
const AUTH_CHOICE_MAP = {
  zai: 'zai-api-key', openai: 'openai-api-key', anthropic: 'apiKey',
  google: 'custom-api-key', xai: 'custom-api-key', mistral: 'custom-api-key',
  minimax: 'custom-api-key', 'minimax-cn': 'custom-api-key',
  groq: 'custom-api-key', openrouter: 'custom-api-key', 'openai-codex': 'openai-api-key',
};

function runOnboardProcess(provider, apiKey, port, logFn) {
  const openclawEntry = getOpenClawEntry();
  if (!openclawEntry) return Promise.reject(new Error('OpenClaw 运行时未找到'));

  const nodeBin = getBundledNodePath();
  const ocHome = getOpenClawHome();
  const markerFile = path.join(ocHome, '.onboarded');

  const args = [
    openclawEntry, 'onboard',
    '--non-interactive', '--accept-risk',
    '--mode', 'local',
    '--flow', 'quickstart',
    '--gateway-port', String(port || 3002),
    '--gateway-auth', 'token',
    '--skip-channels', '--skip-skills', '--skip-daemon', '--skip-ui', '--skip-health',
  ];

  if (apiKey) {
    args.push('--auth-choice', AUTH_CHOICE_MAP[provider] || 'apiKey');
    args.push(AUTH_KEY_MAP[provider] || '--custom-api-key', apiKey);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(nodeBin, args, {
      cwd: path.dirname(openclawEntry),
      windowsHide: true,
      timeout: 60000,
    });
    proc.stdout.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) logFn('info', msg);
    });
    proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) logFn('warn', msg);
    });
    proc.on('close', (code) => {
      if (code === 0) {
        try { fs.mkdirSync(ocHome, { recursive: true }); fs.writeFileSync(markerFile, new Date().toISOString()); } catch {}
        logFn('success', 'OpenClaw 初始化完成');
        resolve();
      } else {
        logFn('warn', `初始化退出 (code: ${code})`);
        reject(new Error(`onboard exited with code ${code}`));
      }
    });
    proc.on('error', (e) => reject(e));
  });
}

// ===== OpenClaw 首次初始化（自动模式，从 startOpenClaw 调用）=====
function ensureOnboarded(provider, apiKey, port) {
  const ocHome = getOpenClawHome();
  const markerFile = path.join(ocHome, '.onboarded');
  if (fs.existsSync(markerFile)) return Promise.resolve();
  if (!getOpenClawEntry() || !apiKey) return Promise.resolve();

  sendLog('info', '首次运行，正在初始化 OpenClaw 配置...');
  return runOnboardProcess(provider, apiKey, port, sendLog).catch(() => {
    sendLog('warn', '自动初始化未完全成功，尝试继续启动...');
  });
}

// ===== OpenClaw 进程管理 =====
async function startOpenClaw() {
  if (openclawProcess) {
    sendLog('warn', 'OpenClaw 已在运行');
    return;
  }

  const apiKey = cfgGet('apiKey') || '';
  const provider = cfgGet('provider') || 'zai';
  const port = cfgGet('port') || 3002;
  const env = { ...process.env };

  // 注入 API Key（环境变量 + OpenClaw 配置文件双写）
  const providerEnvMap = {
    zai: 'ZAI_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY', xai: 'XAI_API_KEY', mistral: 'MISTRAL_API_KEY',
    minimax: 'MINIMAX_API_KEY', 'minimax-cn': 'MINIMAX_API_KEY',
    groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY', 'openai-codex': 'OPENAI_API_KEY',
  };
  if (apiKey) {
    const envKey = providerEnvMap[provider] || `${provider.toUpperCase()}_API_KEY`;
    env[envKey] = apiKey;
  }

  const model = cfgGet('model') || 'zai/glm-5';
  await ensureOnboarded(provider, apiKey, port);
  const ocConfig = ensureOpenClawConfig(provider, model, apiKey, port);

  // ===== Gateway 认证策略 =====
  // 优先级: Launcher accessToken > OpenClaw 配置文件 gateway.auth.token > 无认证
  const accessToken = (cfgGet('accessToken') || '').trim();
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
  const gatewayArgs = ['gateway', '--port', String(port), '--allow-unconfigured'];
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
    spawn('taskkill', ['/pid', String(openclawProcess.pid), '/f', '/t'], { windowsHide: true });
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
  ipcMain.on('window:close', () => {
    isQuitting = true;
    stopOpenClaw();
    app.quit();
  });

  ipcMain.handle('openclaw:start', () => { startOpenClaw(); return true; });
  ipcMain.handle('openclaw:stop', () => { stopOpenClaw(); return true; });
  ipcMain.handle('openclaw:status', () => openclawProcess ? 'running' : 'stopped');

  ipcMain.handle('openclaw:needsOnboard', () => {
    const markerFile = path.join(getOpenClawHome(), '.onboarded');
    return !fs.existsSync(markerFile);
  });

  ipcMain.handle('openclaw:runOnboard', async (_, opts) => {
    const { provider, apiKey, model, port } = opts || {};
    if (provider) cfgSet('provider', provider);
    if (apiKey) cfgSet('apiKey', apiKey);
    if (model) cfgSet('model', model);
    if (port) cfgSet('port', port);

    const p = port || cfgGet('port') || 3002;
    const prov = provider || cfgGet('provider') || 'zai';
    const key = apiKey || cfgGet('apiKey') || '';
    const mdl = model || cfgGet('model') || 'zai/glm-5';

    const sendOnboardLog = (type, message) => {
      sendToRenderer('openclaw:onboardLog', { type, message });
    };

    try {
      sendOnboardLog('info', '正在初始化 OpenClaw 运行环境...');
      await runOnboardProcess(prov, key, p, sendOnboardLog);
      ensureOpenClawConfig(prov, mdl, key, p);
      sendOnboardLog('success', '初始化完成！');
      return { success: true };
    } catch (e) {
      sendOnboardLog('error', `初始化失败: ${e.message}`);
      ensureOpenClawConfig(prov, mdl, key, p);
      sendOnboardLog('info', '已写入基础配置，服务可能仍可启动');
      return { success: false, error: e.message };
    }
  });

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
