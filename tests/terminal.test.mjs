import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function harness(platform, { helperMode = 'message', timers = { setTimeout, clearTimeout }, hasAgent = true, hasHelper = true } = {}) {
  const spawned = [], forks = [];
  const pty = { spawn(shell, args, options) {
    let onData, onExit;
    const terminal = {
      shell, args, options, pid: 42, writes: [], resizes: [], kills: 0,
      _agent: hasAgent ? { _getConsoleProcessList: () => Promise.resolve([42]) } : undefined,
      onData(callback) { onData = callback; },
      onExit(callback) { onExit = callback; },
      write(data) { this.writes.push(data); },
      resize(cols, rows) { this.resizes.push([cols, rows]); },
      kill() { this.kills++; },
      data(data) { onData(data); },
      exit(exitCode = 0) { onExit({ exitCode }); },
    };
    spawned.push(terminal);
    return terminal;
  } };
  const context = vm.createContext({ console, process: { platform, env: { SEED_PI_WEB_SHELL: 'test-shell' } }, ...timers });
  const ptyModule = new vm.SyntheticModule(['default'], function () { this.setExport('default', pty); }, { context });
  await ptyModule.link(() => {});
  await ptyModule.evaluate();
  const source = fs.readFileSync(new URL('../server/terminal.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, importModuleDynamically: () => ptyModule });
  const imports = {
    'node:events': { EventEmitter }, 'node:fs': { default: fs }, 'node:path': { default: path },
    'node:module': { createRequire: () => ({ resolve() {
      if (!hasHelper) throw new Error('Helper was removed');
      return '/mock/node-pty/lib/conpty_console_list_agent.js';
    } }) },
    'node:child_process': {
      execFileSync() { throw new Error('Explicit shell must not invoke where.exe'); },
      fork(file, args, options) {
        const child = new EventEmitter();
        child.kills = 0;
        child.kill = () => { child.kills++; child.emit('exit', 1); };
        forks.push({ file, args, options, child });
        if (helperMode === 'throw') throw new Error('Cannot fork');
        queueMicrotask(() => {
          if (helperMode === 'message') child.emit('message', { consoleProcessList: [42, 43] });
          if (helperMode === 'malformed') child.emit('message', {});
          if (helperMode === 'error') child.emit('error', new Error('Cannot start helper'));
          if (helperMode === 'exit') child.emit('exit', 1);
        });
        return child;
      },
    },
  };
  await module.link((name) => {
    const values = imports[name];
    assert.ok(values, name);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return { manager: new module.namespace.TerminalManager(), spawned, forks };
}

for (const platform of ['win32', 'linux']) {
  test(`${platform} terminal preserves its backend, output, resize and close lifecycle`, async () => {
    const { manager, spawned, forks } = await harness(platform);
    const events = [];
    manager.on('data', (...args) => events.push(['data', ...args]));
    manager.on('exit', (...args) => events.push(['exit', ...args]));
    const terminal = manager.open({ cwd: '/work', cols: 90, rows: 30 });
    const pty = spawned[0];
    assert.equal(pty.shell, 'test-shell');
    assert.equal(pty.options.cols, 90);
    assert.equal(pty.options.rows, 30);
    assert.equal(pty.options.env.TERM, 'xterm-256color');
    assert.equal('useConpty' in pty.options, false);
    assert.equal('useConptyDll' in pty.options, false, 'do not switch to the experimental DLL shutdown path');
    const pids = await pty._agent._getConsoleProcessList();
    if (platform === 'win32') {
      assert.deepEqual(Array.from(pids), [42, 43]);
      assert.equal(forks.length, 1);
      assert.equal(forks[0].options.windowsHide, true);
      assert.equal(forks[0].options.stdio[3], 'ipc');
      assert.equal(forks[0].options.execArgv.length, 0, 'helpers must not inherit debugger or --input-type arguments');
      assert.deepEqual(Array.from(forks[0].args), ['42']);
    } else {
      assert.equal(forks.length, 0);
    }
    pty.data('hello');
    assert.equal(terminal.buffer, 'hello');
    terminal.write('input');
    terminal.resize(120, 40);
    terminal.resize(0, 40);
    assert.deepEqual(pty.writes, ['input']);
    assert.deepEqual(pty.resizes, [[120, 40]]);
    manager.close(terminal.id);
    assert.equal(pty.kills, 1);
    pty.exit(0);
    assert.equal(manager.get(terminal.id), undefined);
    assert.equal(terminal.alive, false);
    terminal.write('ignored');
    manager.close(terminal.id);
    assert.equal(pty.kills, 1);
    assert.deepEqual(events, [['data', terminal.id, 'hello'], ['exit', terminal.id, 0]]);
    manager.open({ cwd: '/work' });
    manager.open({ cwd: '/work' });
    manager.closeAll();
    assert.equal(spawned[1].kills, 1);
    assert.equal(spawned[2].kills, 1);
  });
}

for (const helperMode of ['throw', 'error', 'exit', 'malformed']) {
  test(`console helper ${helperMode} falls back to the shell PID without crashing or leaving a timer`, async () => {
    const pending = new Map();
    const { manager, spawned } = await harness('win32', { helperMode, timers: {
      setTimeout(callback, ms) { pending.set(1, { callback, ms }); return 1; },
      clearTimeout(id) { pending.delete(id); },
    } });
    manager.open({ cwd: '/work' });
    assert.deepEqual(Array.from(await spawned[0]._agent._getConsoleProcessList()), [42]);
    assert.equal(pending.size, 0);
  });
}

test('stalled console helper times out, terminates and resolves only once', async () => {
  const pending = new Map();
  const { manager, spawned, forks } = await harness('win32', { helperMode: 'hang', timers: {
    setTimeout(callback, ms) { pending.set(1, { callback, ms }); return 1; },
    clearTimeout(id) { pending.delete(id); },
  } });
  manager.open({ cwd: '/work' });
  const result = spawned[0]._agent._getConsoleProcessList();
  assert.equal(pending.get(1).ms, 5000);
  pending.get(1).callback();
  assert.deepEqual(Array.from(await result), [42]);
  assert.equal(forks[0].child.kills, 1);
  assert.equal(pending.size, 0);
  forks[0].child.emit('message', { consoleProcessList: [999] });
  assert.deepEqual(Array.from(await result), [42]);
});

test('PTY implementations without the console-list hook are left unchanged', async () => {
  const { manager, spawned, forks } = await harness('win32', { hasAgent: false });
  const terminal = manager.open({ cwd: '/work' });
  manager.close(terminal.id);
  assert.equal(spawned[0].kills, 1);
  assert.equal(forks.length, 0);
});

test('a dependency without the legacy helper keeps its own process-list implementation', async () => {
  const { manager, spawned, forks } = await harness('win32', { hasHelper: false });
  const terminal = manager.open({ cwd: '/work' });
  assert.deepEqual(await spawned[0]._agent._getConsoleProcessList(), [42]);
  manager.close(terminal.id);
  assert.equal(spawned[0].kills, 1);
  assert.equal(forks.length, 0);
});

test('Windows taskkill fallbacks hide their console windows', () => {
  const agent = fs.readFileSync(new URL('../server/pi-agent.js', import.meta.url), 'utf8');
  const cli = fs.readFileSync(new URL('../bin/seed-pi-web.js', import.meta.url), 'utf8');
  assert.match(agent, /execFile\('taskkill', \[[^\]]+\], \{ windowsHide: true \}/);
  assert.match(cli, /execFileSync\('taskkill', \[[^\]]+\], \{ stdio: 'ignore', windowsHide: true \}/);
});

test('real Windows PTY hides its helper, closes shell and child processes, and releases native workers', {
  skip: process.platform !== 'win32', timeout: 25000,
}, async (t) => {
  // The subprocess must exit by itself. A leaked PTY worker would trigger execFile's timeout.
  const command = `"${process.execPath}" -e "console.log('__PTY_CHILD__:'+process.pid);setInterval(()=>{},1000)"\r`;
  const script = `
    import cp from 'node:child_process';
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    import { TerminalManager, terminalAvailable } from ${JSON.stringify(new URL('../server/terminal.js', import.meta.url).href)};
    if (!terminalAvailable()) {
      console.log(JSON.stringify({ skipped: true }));
    } else {
      process.env.SEED_PI_WEB_SHELL = 'cmd.exe';
      const manager = new TerminalManager();
      const originalFork = cp.fork;
      const helperForks = [];
      let terminal, shellPid, childPid;
      cp.fork = function (file, ...args) {
        if (String(file).includes('conpty_console_list_agent')) helperForks.push(args.at(-1)?.windowsHide === true);
        return originalFork.call(this, file, ...args);
      };
      syncBuiltinESMExports();
      const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
      const waitFor = async check => {
        const deadline = Date.now() + 8000;
        while (!check()) {
          if (Date.now() > deadline) throw new Error('PTY lifecycle timed out');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      };
      try {
        terminal = manager.open({ cwd: os.tmpdir() });
        shellPid = terminal.p.pid;
        terminal.write(${JSON.stringify(command)});
        await waitFor(() => /__PTY_CHILD__:(\\d+)/.test(terminal.buffer));
        childPid = Number(terminal.buffer.match(/__PTY_CHILD__:(\\d+)/)[1]);
        manager.close(terminal.id);
        await waitFor(() => !manager.get(terminal.id) && !alive(shellPid) && !alive(childPid));
        if (helperForks.length !== 1 || helperForks.some(hidden => !hidden)) throw new Error('Console-list helper was not hidden');
        console.log(JSON.stringify({ shellClosed: true, childClosed: true, helperHidden: true }));
      } finally {
        cp.fork = originalFork;
        syncBuiltinESMExports();
        manager.closeAll();
        for (const pid of [childPid, shellPid]) if (alive(pid)) { try { process.kill(pid); } catch {} }
      }
    }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  if (result.skipped) return t.skip('node-pty is unavailable');
  assert.deepEqual(result, { shellClosed: true, childClosed: true, helperHidden: true });
});
