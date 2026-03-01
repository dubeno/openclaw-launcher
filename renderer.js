// ===== OpenClaw Launcher - Renderer =====
const { openclaw, config, window: win } = window.electronAPI;
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let serviceRunning = false;

// ===== 初始化（不阻塞渲染）=====
document.addEventListener('DOMContentLoaded', () => {
  setupWindowControls();
  setupButtons();
  setupConfigPanel();
  setupIPCListeners();
  // 配置延迟加载，不阻塞首帧（兼容不支持 requestIdleCallback 的环境）
  const idleLoad = window.requestIdleCallback
    ? (fn) => window.requestIdleCallback(fn)
    : (fn) => setTimeout(fn, 1);
  idleLoad(() => loadConfig());
  // 快速检查状态
  openclaw.getStatus().then(s => {
    if (s === 'running') { updateStatus('running'); loadWebView(); }
  });
});

// ===== 窗口控制 =====
function setupWindowControls() {
  $('#btn-minimize').onclick = () => win.minimize();
  $('#btn-maximize').onclick = () => win.maximize();
  $('#btn-close').onclick = () => win.close();
}

// ===== 按钮事件 =====
function setupButtons() {
  $('#btn-start').onclick = () => openclaw.start();
  $('#btn-stop').onclick = async () => {
    await openclaw.stop();
    showSplash('服务已停止，点击启动重新运行');
  };
  $('#splash-start-btn').onclick = () => {
    $('#splash-start-btn').style.display = 'none';
    $('#splash-loader').style.display = 'block';
    $('#splash-msg').textContent = '正在启动服务...';
    openclaw.start();
  };
}

// ===== 配置面板 =====
function setupConfigPanel() {
  const openPanel = () => {
    $('#config-overlay').classList.add('open');
    $('#config-panel').classList.add('open');
  };
  const closePanel = () => {
    $('#config-overlay').classList.remove('open');
    $('#config-panel').classList.remove('open');
  };

  $('#btn-config').onclick = openPanel;
  $('#btn-config-close').onclick = closePanel;
  $('#config-overlay').onclick = closePanel;

  $('#btn-toggle-key').onclick = () => {
    const i = $('#cfg-apikey');
    i.type = i.type === 'password' ? 'text' : 'password';
  };

  $('#cfg-channel').onchange = updateChannelFields;
  $('#btn-save-config').onclick = saveConfig;

  $('#btn-restart').onclick = async () => {
    closePanel();
    await openclaw.stop();
    showSplash('正在重启服务...');
    setTimeout(() => openclaw.start(), 800);
  };
}

// ===== IPC 监听 =====
function setupIPCListeners() {
  openclaw.onLog(appendSplashLog);
  openclaw.onStatus(updateStatus);
  openclaw.onReady(loadWebView);
}

// ===== 状态更新 =====
function updateStatus(status) {
  const dot = $('#status-dot');
  const text = $('#status-text');
  const startBtn = $('#btn-start');
  const stopBtn = $('#btn-stop');
  dot.className = 'status-dot ' + status;

  const map = {
    running:  ['运行中', true, false, true],
    starting: ['启动中...', true, true, false],
    stopping: ['停止中...', true, true, false],
  };
  const [label, disStart, disStop, running] = map[status] || ['未启动', false, true, false];
  text.textContent = label;
  startBtn.disabled = disStart;
  stopBtn.disabled = disStop;
  serviceRunning = !!running;
}

// ===== WebView =====
let webviewBound = false;
let retryCount = 0;
const MAX_RETRIES = 8;
let currentWebviewUrl = '';

async function loadWebView(data) {
  let port, token;
  if (data && typeof data === 'object') {
    port = data.port;
    token = data.token;
  } else {
    port = data;
  }
  if (!port) port = (await config.get('port')) || 3002;
  if (!token) token = ((await config.get('accessToken')) || '').trim();
  const webview = $('#webview');
  const tokenHash = token ? `#token=${encodeURIComponent(token)}` : '';
  currentWebviewUrl = `http://127.0.0.1:${port}/${tokenHash}`;

  retryCount = 0;
  webview.src = currentWebviewUrl;
  webview.style.display = 'flex';

  if (!webviewBound) {
    webviewBound = true;

    // 页面加载成功 → 隐藏 splash
    webview.addEventListener('did-finish-load', () => {
      // 检查是否是错误页面（通过 URL 判断）
      const currentUrl = webview.getURL();
      if (currentUrl && currentUrl.startsWith('http://127.0.0.1')) {
        $('#splash').classList.add('hidden');
        retryCount = 0;
      }
    });

    // 监听页面内 HTTP 错误（401/403 等）
    webview.addEventListener('did-navigate', (e) => {
      if (e.httpResponseCode === 401 || e.httpResponseCode === 403) {
        appendSplashLog({ type: 'warn', message: `Web UI 认证失败 (${e.httpResponseCode})，请检查 Access Token 是否与网关一致` });
        // 不再无限重试认证错误
        showSplash('认证失败，请在设置中检查配置后重启服务');
        webview.style.display = 'none';
        webview.src = 'about:blank';
        return;
      }
    });

    // 连接级失败（服务还没起来等）→ 指数退避重试
    webview.addEventListener('did-fail-load', (e) => {
      // 忽略被中止的加载（比如我们主动改了 src）
      if (e.errorCode === -3) return; // ERR_ABORTED

      if (serviceRunning && retryCount < MAX_RETRIES) {
        retryCount++;
        const delay = Math.min(1500 * Math.pow(1.5, retryCount - 1), 10000);
        appendSplashLog({ type: 'info', message: `页面加载失败，${(delay/1000).toFixed(1)}s 后重试 (${retryCount}/${MAX_RETRIES})...` });
        setTimeout(() => {
          if (serviceRunning && currentWebviewUrl) webview.src = currentWebviewUrl;
        }, delay);
      } else if (retryCount >= MAX_RETRIES) {
        appendSplashLog({ type: 'error', message: '多次重试失败，请检查服务状态或手动重启' });
        showSplash('加载失败，请检查服务后重试');
      }
    });

    // 控制台消息（方便调试）
    webview.addEventListener('console-message', (e) => {
      if (e.level >= 2) { // warn + error
        console.warn('[WebView]', e.message);
      }
    });
  }
}

// ===== Splash =====
function showSplash(message) {
  $('#splash').classList.remove('hidden');
  $('#webview').style.display = 'none';
  retryCount = 0;
  $('#splash-msg').textContent = message || '正在启动服务...';
  $('#splash-start-btn').style.display = serviceRunning ? 'none' : 'inline-flex';
  $('#splash-loader').style.display = serviceRunning ? 'block' : 'none';
}

function appendSplashLog(data) {
  const c = $('#splash-log');
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const el = document.createElement('div');
  el.className = 'log-line';
  el.innerHTML = `<span class="log-time">${t}</span><span class="msg-${data.type}">${esc(data.message)}</span>`;
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;
  // 限制日志行数
  while (c.childElementCount > 50) c.removeChild(c.firstChild);
}

// ===== Channel 字段切换 =====
function updateChannelFields() {
  const ch = $('#cfg-channel').value;
  $$('.channel-section').forEach(s => {
    s.style.display = s.dataset.channel === ch ? 'block' : 'none';
  });
}

// ===== 配置读写 =====
async function loadConfig() {
  try {
    const c = await config.getAll();
    if (!c) return;

    if (c.provider) $('#cfg-provider').value = c.provider;
    if (c.apiKey) $('#cfg-apikey').value = c.apiKey;
    if (c.accessToken) $('#cfg-access-token').value = c.accessToken;
    if (c.model) $('#cfg-model').value = c.model;
    if (c.port) $('#cfg-port').value = c.port;
    if (c.autoStart !== undefined) $('#cfg-autostart').checked = c.autoStart;
    if (c.channel) $('#cfg-channel').value = c.channel;
    updateChannelFields();

    // Channel fields
    const cc = c.channelConfig || {};
    const fieldMap = {
      'wechat-appid': cc.wechat?.appId,
      'wechat-secret': cc.wechat?.appSecret,
      'wechat-token': cc.wechat?.token,
      'telegram-token': cc.telegram?.botToken,
      'discord-token': cc.discord?.botToken,
      'slack-token': cc.slack?.botToken,
      'slack-secret': cc.slack?.signingSecret,
      'dingtalk-key': cc.dingtalk?.appKey,
      'dingtalk-secret': cc.dingtalk?.appSecret,
      'feishu-appid': cc.feishu?.appId,
      'feishu-secret': cc.feishu?.appSecret,
    };
    for (const [id, val] of Object.entries(fieldMap)) {
      if (val) $(`#cfg-${id}`).value = val;
    }
  } catch (e) {
    console.error('Load config:', e);
  }
}

async function saveConfig() {
  const cfg = {
    provider: $('#cfg-provider').value,
    apiKey: $('#cfg-apikey').value.trim(),
    accessToken: ($('#cfg-access-token')?.value || '').trim(),
    model: $('#cfg-model').value,
    port: parseInt($('#cfg-port').value) || 3002,
    autoStart: $('#cfg-autostart').checked,
    channel: $('#cfg-channel').value,
    channelConfig: {
      wechat: {
        appId: $('#cfg-wechat-appid').value.trim(),
        appSecret: $('#cfg-wechat-secret').value.trim(),
        token: $('#cfg-wechat-token').value.trim()
      },
      telegram: { botToken: $('#cfg-telegram-token').value.trim() },
      discord: { botToken: $('#cfg-discord-token').value.trim() },
      slack: {
        botToken: $('#cfg-slack-token').value.trim(),
        signingSecret: $('#cfg-slack-secret').value.trim()
      },
      dingtalk: {
        appKey: $('#cfg-dingtalk-key').value.trim(),
        appSecret: $('#cfg-dingtalk-secret').value.trim()
      },
      feishu: {
        appId: $('#cfg-feishu-appid').value.trim(),
        appSecret: $('#cfg-feishu-secret').value.trim()
      }
    }
  };
  try {
    await config.save(cfg);
    showToast('配置已保存 ✓', 'success');
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

// ===== Toast =====
function showToast(message, type = 'info') {
  const t = $('#toast');
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icons[type] || ''}</span><span>${esc(message)}</span>`;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 3000);
}

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}
