/**
 * 🔧 一键打包运行时脚本
 * 
 * 作用：将系统上的 Node.js 和 OpenClaw 复制到 resources/ 目录
 * 这样 electron-builder 会将它们打包进最终安装文件
 * 
 * 用法：node scripts/bundle-runtime.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RESOURCES_DIR = path.join(__dirname, '..', 'resources');
const NODE_DIR = path.join(RESOURCES_DIR, 'node');
const OPENCLAW_DIR = path.join(RESOURCES_DIR, 'openclaw');

function log(msg) { console.log(`\x1b[36m[bundle]\x1b[0m ${msg}`); }
function success(msg) { console.log(`\x1b[32m[✓]\x1b[0m ${msg}`); }
function error(msg) { console.error(`\x1b[31m[✗]\x1b[0m ${msg}`); }

// ===== 1. 复制 Node.js =====
function bundleNode() {
  log('正在打包 Node.js 运行时...');

  // 找到系统 node.exe
  let nodeSrc;
  try {
    nodeSrc = execSync('where node', { encoding: 'utf-8' }).trim().split('\n')[0].trim();
  } catch {
    error('找不到 node.exe！请确保 Node.js 已安装');
    process.exit(1);
  }

  // 检查版本
  const nodeVersion = execSync('node -v', { encoding: 'utf-8' }).trim();
  const majorVersion = parseInt(nodeVersion.replace('v', '').split('.')[0]);
  if (majorVersion < 22) {
    error(`Node.js 版本 ${nodeVersion} 太低，OpenClaw 需要 >= 22.12.0`);
    process.exit(1);
  }

  // 创建目录
  fs.mkdirSync(NODE_DIR, { recursive: true });

  // 复制 node.exe
  const nodeDest = path.join(NODE_DIR, 'node.exe');
  fs.copyFileSync(nodeSrc, nodeDest);
  
  const sizeMB = (fs.statSync(nodeDest).size / 1024 / 1024).toFixed(1);
  success(`Node.js ${nodeVersion} 已复制 (${sizeMB} MB) → ${nodeDest}`);
}

// ===== 2. 复制 OpenClaw =====
function bundleOpenClaw() {
  log('正在打包 OpenClaw...');

  // 找到全局安装的 openclaw
  let openclawSrc;
  const globalDir = execSync('npm root -g', { encoding: 'utf-8' }).trim();
  openclawSrc = path.join(globalDir, 'openclaw');

  if (!fs.existsSync(openclawSrc)) {
    error(`找不到 openclaw 包: ${openclawSrc}`);
    error('请先全局安装: npm install -g openclaw');
    process.exit(1);
  }

  // 检查版本
  const pkgJson = JSON.parse(fs.readFileSync(path.join(openclawSrc, 'package.json'), 'utf-8'));
  log(`OpenClaw 版本: ${pkgJson.version}`);

  // 创建目标目录
  if (fs.existsSync(OPENCLAW_DIR)) {
    log('清理旧的 openclaw 目录...');
    fs.rmSync(OPENCLAW_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OPENCLAW_DIR, { recursive: true });

  // 递归复制整个 openclaw 包
  log('正在复制 OpenClaw 文件 (可能需要几分钟)...');
  copyDirSync(openclawSrc, OPENCLAW_DIR);

  // 统计大小
  const totalSize = getDirSize(OPENCLAW_DIR);
  const sizeMB = (totalSize / 1024 / 1024).toFixed(1);
  success(`OpenClaw v${pkgJson.version} 已复制 (${sizeMB} MB) → ${OPENCLAW_DIR}`);
}

// ===== 工具函数 =====
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // 跳过不需要的文件
    if (shouldSkip(entry.name)) continue;

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      // 解析符号链接，复制实际文件
      try {
        const realPath = fs.realpathSync(srcPath);
        if (fs.statSync(realPath).isDirectory()) {
          copyDirSync(realPath, destPath);
        } else {
          fs.copyFileSync(realPath, destPath);
        }
      } catch {
        // 忽略无效的符号链接
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function shouldSkip(name) {
  // 跳过不需要的文件/目录以减少体积
  const skipList = [
    '.git', '.github', '.vscode',
    'test', 'tests', '__tests__',
    '.eslintrc', '.prettierrc',
    'tsconfig.json', 'jest.config',
    '*.test.js', '*.spec.js',
    'CONTRIBUTING.md', 'SECURITY.md',
    '.npmignore', '.gitignore'
  ];
  return skipList.some(pattern => {
    if (pattern.startsWith('*')) {
      return name.endsWith(pattern.slice(1));
    }
    return name === pattern;
  });
}

function getDirSize(dir) {
  let totalSize = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        totalSize += getDirSize(fullPath);
      } else {
        totalSize += fs.statSync(fullPath).size;
      }
    }
  } catch {}
  return totalSize;
}

// ===== 主流程 =====
function main() {
  console.log('\n🚀 OpenClaw Launcher - 打包运行时\n');
  console.log('=' .repeat(50));

  // 清理旧的 resources
  fs.mkdirSync(RESOURCES_DIR, { recursive: true });

  bundleNode();
  console.log('');
  bundleOpenClaw();

  console.log('\n' + '='.repeat(50));
  success('运行时打包完成！');
  console.log('');
  log('resources/ 目录结构:');
  log('  resources/');
  log('  ├── node/');
  log('  │   └── node.exe');
  log('  └── openclaw/');
  log('      ├── openclaw.mjs');
  log('      ├── dist/');
  log('      └── node_modules/');
  console.log('');
  log('现在可以运行: npm run build:win 来打包安装程序');
  console.log('');
}

main();

