import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {DebuggerSessionPool} from '../extension/page-observation.js';

const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const commandSource = source.slice(source.indexOf('async function executeCommand('), source.indexOf('\nasync function runAndCheckMutation('));
const inputSource = source.slice(source.indexOf('async function runTrustedVisualInput('), source.indexOf('\nfunction sameVisualTargetState('));

for (const virtualOnly of [false, true]) test(`visual pointer label uses broker task identity (virtualOnly=${virtualOnly})`, async () => {
  const overlays = [];
  const commands = [];
  const context = {
    requireTabId: value => value,
    assertLiveOrigin: async () => {},
    requireVisualPoint: value => value,
    requireTrustedDebuggerAccess: async () => {},
    runPageOperation: async (tabId, action, payload) => { overlays.push({ tabId, action, payload }); return { shown: true }; },
    withTimeout: promise => promise,
    moveMouse: async () => { commands.push('move'); },
    chrome: {
      tabs: {
        get: async id => ({ id, windowId: 2 }),
        query: async () => [{ id: 11, windowId: 2 }],
        update: async () => {},
      },
      windows: { update: async () => {} },
      debugger: { attach: async () => {}, detach: async () => {} },
    },
  };
  context.debuggerSessions=new DebuggerSessionPool(context.chrome.debugger);
  vm.createContext(context);
  vm.runInContext(inputSource + '\n' + commandSource, context);
  await context.executeCommand('visual.pointerMove', {
    tabId: 11, point: { x: 50, y: 60 }, virtualOnly,
    taskId: 'signed-task', taskLabel: '日本語の現在タスク',
    companionContext: { taskId: 'untrusted-other', taskLabel: 'Wrong owner' },
  });
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0].tabId, 11);
  assert.equal(overlays[0].action, 'showVisualPoint');
  assert.equal(overlays[0].payload.companionContext.taskId, 'signed-task');
  assert.equal(overlays[0].payload.companionContext.taskLabel, '日本語の現在タスク');
  assert.equal(commands.length, virtualOnly ? 0 : 1);
});
