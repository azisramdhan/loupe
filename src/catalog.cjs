const id = value => ({ using: 'accessibility id', value });
const predicate = value => ({ using: '-ios predicate string', value });
const className = value => ({ using: 'class name', value });
const iosWebView = predicate("type == 'XCUIElementTypeWebView'");
const androidWebView = className('android.webkit.WebView');
const renderedText = { using: 'xpath', value: '//android.webkit.WebView//*[string-length(@text) > 0]' };
const localDemoButton = id('Skip to Local HTML Demo');

const ios = {
  platform: 'ios',
  name: 'WebKitDemo',
  repository: 'azisramdhan/WebKitDemo',
  appId: 'com.azisramdhan.WebKitDemo',
  screens: [{
    id: 'login', name: 'Login', aliases: ['login', 'main'],
    description: 'Initial LoginViewController from App/SceneDelegate.swift. main is an alias for login.',
    steps: [], ready: id('Log In'), settleMs: 800
  }, {
    id: 'web', name: 'Web Browser', aliases: ['web'],
    description: 'WebViewController pushed after a successful admin login; loads example.com.',
    steps: [
      { action: 'type', ...id('Username'), text: 'admin' },
      { action: 'type', ...id('Password'), text: 'password' },
      { action: 'dismissKeyboard' },
      { action: 'tap', ...id('Log In') }
    ],
    ready: iosWebView, settleMs: 4000, scroll: true
  }, {
    id: 'local-demo', name: 'Local HTML Demo', aliases: ['local-demo'],
    description: 'WebViewController showing bundled Resources/HTMLSamples/index.html.',
    steps: [{ action: 'tap', ...localDemoButton }, { action: 'wait', ...iosWebView }],
    ready: predicate("label CONTAINS 'WebKit Bridge Demo'"), settleMs: 1000, scroll: true
  }, {
    id: 'legacy', name: 'Legacy Info', aliases: ['legacy'],
    description: "LegacyWebViewController reached from the browser's Legacy bar button.",
    steps: [
      { action: 'tap', ...localDemoButton },
      { action: 'wait', ...iosWebView },
      { action: 'tap', ...id('Legacy') }
    ],
    ready: predicate("type == 'XCUIElementTypeNavigationBar' AND name == 'Legacy UIWebView Info'"),
    settleMs: 800
  }]
};

// The Android app gives every control the same accessibility id as its iOS twin,
// so only the readiness checks differ between these two recipes.
const android = {
  platform: 'android',
  name: 'WebViewDemo',
  repository: 'azisramdhan/WebViewDemo',
  appId: 'com.azisramdhan.webviewdemo',
  screens: [{
    id: 'login', name: 'Login', aliases: ['login', 'main'],
    description: 'LoginActivity, the launcher screen. main is an alias for login.',
    steps: [], ready: id('Log In'), settleMs: 800
  }, {
    id: 'web', name: 'Web Browser', aliases: ['web'],
    description: 'WebActivity, reached by signing in as admin; loads example.com.',
    steps: [
      { action: 'type', ...id('Username'), text: 'admin' },
      { action: 'type', ...id('Password'), text: 'password' },
      { action: 'dismissKeyboard' },
      { action: 'tap', ...id('Log In') }
    ],
    // A WebView satisfies a class-name locator the moment it attaches, well before
    // it has painted. Waiting for rendered text instead makes the capture wait for
    // the page itself rather than for a guessed number of seconds.
    ready: renderedText, readyTimeoutMs: 60000, settleMs: 1200, scroll: true
  }, {
    id: 'local-demo', name: 'Local HTML Demo', aliases: ['local-demo'],
    description: 'LocalDemoActivity showing the bundled assets/index.html.',
    steps: [{ action: 'tap', ...localDemoButton }],
    ready: renderedText, readyTimeoutMs: 45000, settleMs: 1200, scroll: true
  }, {
    id: 'legacy', name: 'Legacy Info', aliases: ['legacy'],
    description: "LegacyActivity reached from the Legacy action in the local demo's toolbar.",
    steps: [
      { action: 'tap', ...localDemoButton },
      { action: 'wait', ...androidWebView },
      { action: 'tap', ...id('Legacy') }
    ],
    ready: id('Legacy WebView Info'), settleMs: 800
  }]
};

const projects = [ios, android];
const PLATFORM_NAMES = { ios: 'iOS', android: 'Android' };

const projectFor = repository =>
  projects.find(p => p.repository.toLowerCase() === String(repository || '').toLowerCase()) || null;

const commandNames = project => {
  const names = project.screens.flatMap(screen => screen.aliases);
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
};

function parseCommand(body, project) {
  if (typeof body !== 'string' || !/^\/farm(?:\s|$)/.test(body.trim())) return null;
  const match = body.trim().match(/^\/farm[ \t]+([a-zA-Z][a-zA-Z0-9_-]{0,63})(?:[ \t]+(--all))?$/);
  if (!match) throw new Error(`Use /farm followed by one screen name, optionally with --all: ${commandNames(project)}. For example /farm local-demo --all.`);
  const parameter = match[1];
  const screen = project.screens.find(s => s.aliases.includes(parameter.toLowerCase())) || null;
  return { repository: project.repository, appId: project.appId, platform: project.platform,
    parameter, allDevices: !!match[2], screen, mapping: screen ? 'known' : 'unmapped' };
}

module.exports = { projects, projectFor, parseCommand, commandNames, PLATFORM_NAMES, project: ios };
