import {readFile, writeFile, access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Uses only Node built-ins so first launch works before npm ci.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const [major, minor] = process.versions.node.split('.').map(Number);
let child;
let stopping = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = file => access(file).then(() => true, () => false);

function run(command, args, env) {
  const result = spawnSync(command, args, {cwd: root, env, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed: ${command} ${args.join(' ')}`);
}

async function checkPort(port) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', error => reject(new Error(
      error.code === 'EADDRINUSE'
        ? `Port ${port} is already in use. Close the other IZDT window or choose IZDT_PORT.`
        : `Cannot use port ${port}: ${error.message}`
    )));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}

function stop() {
  stopping = true;
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', stop);

try {
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error(`Node.js 22.12+ is required. Installed: ${process.version}. https://nodejs.org/en/download`);
  }
  const port = Number(process.env.IZDT_PORT || 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('IZDT_PORT must be an integer between 1024 and 65535.');
  }
  await checkPort(port);
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    LOCAL_ONLY: '1',
    TEST_MODE: '1',
    EDITOR_TOKEN: '',
    DATA_DIR: path.join(root, 'data/books/bees'),
    PREVIEW_API_BASE: ''
  };
  const hash = createHash('sha256')
    .update(await readFile('package-lock.json'))
    .update(`${process.platform}:${process.arch}:${major}`)
    .digest('hex');
  const stamp = 'node_modules/.izdt-local-install';
  const previous = await readFile(stamp, 'utf8').catch(() => '');
  const installed = await Promise.all([
    'node_modules/linkedom/package.json',
    'node_modules/sanitize-html/package.json',
    'node_modules/lucide-static/package.json'
  ].map(exists));
  if (previous !== hash || installed.includes(false)) {
    console.log('\nInstalling dependencies. Internet is required for the first launch.\n');
    if (process.platform === 'win32') {
      // npm.cmd must be invoked through cmd.exe, not spawn() directly.
      run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm ci --include=dev'], env);
    } else {
      run('npm', ['ci', '--include=dev'], env);
    }
    await writeFile(stamp, hash);
  }
  if (stopping) process.exit(0);
  console.log('\nBuilding IZDT...\n');
  run(process.execPath, ['scripts/build.js'], env);
  if (stopping) process.exit(0);
  const url = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/index.js'], {cwd: root, env, stdio: 'inherit'});
  const ended = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({code, signal}));
  });
  // Prevent an unhandled rejection if spawn fails while readiness is checked.
  ended.catch(() => {});
  let ready = false;
  for (let i = 0; i < 100 && !stopping; i++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      const response = await fetch(`${url}/api/health`, {signal: AbortSignal.timeout(500)});
      const status = await response.json();
      if (response.ok && status.ok && status.localOnly) {ready = true; break;}
    } catch {}
    await sleep(100);
  }
  if (stopping) {
    await ended;
  } else {
    if (!ready) throw new Error('The local server did not start. Check the messages above.');
    console.log(`\nIZDT is ready: ${url}\nLocal computer only. Keep this window open.\nWait for edits to save, then press Ctrl+C to stop.\n`);
    if (process.platform === 'win32' && process.env.IZDT_NO_BROWSER !== '1') {
      const browser = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], {stdio: 'ignore'});
      browser.on('error', () => console.log(`Open ${url} in your browser.`));
      browser.unref();
    }
    const {code, signal} = await ended;
    if (!stopping && (code !== 0 || signal)) throw new Error(`Server stopped unexpectedly (${code ?? signal}).`);
  }
} catch (error) {
  stop();
  console.error(`\n${error.message}\n`);
  process.exitCode = 1;
}
