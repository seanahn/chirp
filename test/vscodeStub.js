'use strict';
// A fake vscode module, installed for require('vscode'), so host tests run without VS Code. It records what the
// extension does: registered providers, commands, panels and the messages posted to them.
const Module = require('module');
const origLoad = Module._load;

class Emitter {
  constructor() { this.fns = []; this.event = (fn) => { this.fns.push(fn); return { dispose: () => { this.fns = this.fns.filter((f) => f !== fn); } }; }; }
  fire(x) { for (const f of [...this.fns]) f(x); }
}

function fakeWebview() {
  const recv = new Emitter();
  return {
    html: '', options: {}, cspSource: 'vscode-resource:', posted: [],
    postMessage(m) { this.posted.push(JSON.parse(JSON.stringify(m))); return Promise.resolve(true); },
    onDidReceiveMessage: recv.event, _receive: (m) => recv.fire(m),
    asWebviewUri: (u) => u,
  };
}

function install() {
  const ui = { providers: {}, panels: [], commands: {}, executed: [], opened: [], focused: true, config: {}, out: [], watchers: [] };
  const windowState = new Emitter();
  const Uri = {
    file: (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => 'file://' + p }),
    joinPath: (u, ...parts) => Uri.file(require('path').join(u.fsPath, ...parts)),
    parse: (s) => ({ toString: () => s, scheme: s.split(':')[0] }),
  };
  function createWebviewPanel(viewType, title, column, options) {
    const disposed = new Emitter(), viewState = new Emitter();
    const panel = {
      viewType, title, options, webview: fakeWebview(), visible: true, active: true, disposed: false, revealed: 0,
      reveal() { this.revealed++; this.visible = true; this.active = true; viewState.fire({ webviewPanel: this }); },
      dispose() { if (this.disposed) return; this.disposed = true; disposed.fire(); },
      onDidDispose: disposed.event, onDidChangeViewState: viewState.event,
      _setView(visible, active) { this.visible = visible; this.active = active; viewState.fire({ webviewPanel: this }); },
    };
    ui.panels.push(panel);
    return panel;
  }
  const vscode = {
    Uri, EventEmitter: Emitter,
    ViewColumn: { Active: -1, One: 1, Two: 2 },
    window: {
      get state() { return { focused: ui.focused }; },
      onDidChangeWindowState: windowState.event,
      registerWebviewViewProvider: (id, provider) => { ui.providers[id] = provider; return { dispose() {} }; },
      registerWebviewPanelSerializer: (id, s) => { ui.serializer = s; return { dispose() {} }; },
      createWebviewPanel,
      createOutputChannel: () => ({ appendLine: (l) => ui.out.push(l), dispose() {} }),
      showErrorMessage: (m) => { ui.out.push('error: ' + m); },
    },
    commands: {
      registerCommand: (id, fn) => { ui.commands[id] = fn; return { dispose() {} }; },
      executeCommand: async (id, ...a) => { ui.executed.push([id, ...a]); return ui.commands[id] ? ui.commands[id](...a) : undefined; },
    },
    workspace: { getConfiguration: (section) => ({ get: (k, d) => { const v = ui.config[(section ? section + '.' : '') + k]; return v === undefined ? d : v; } }) },
    env: { openExternal: async (u) => { ui.opened.push(u.toString()); return true; } },
  };
  Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : origLoad.call(this, request, ...rest); };
  ui.setFocus = (f) => { ui.focused = f; windowState.fire({ focused: f }); };
  /** Shows the sidebar: resolves the registered view provider with a fake view. */
  ui.resolveSidebar = () => {
    const view = { webview: fakeWebview(), badge: undefined, visible: true, show() {}, onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }) };
    ui.providers['chirp.sidebar'].resolveWebviewView(view, {}, {});
    ui.view = view;
    return view;
  };
  return { vscode, ui };
}

function memento() { const m = new Map(); return { get: (k) => m.get(k), update: (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); return Promise.resolve(); } }; }

module.exports = { install, memento, Emitter };
