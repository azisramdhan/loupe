const $ = id => document.getElementById(id);
let state, refreshing = false, connectionErrorShown = false, selectedId = null, screenFilter = null;
// Electron wraps every handler rejection; the user should see the message, not the plumbing.
const plain = text => String(text).replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '');
function message(text, error = false) { text = plain(text); $('message').hidden = !text; $('message').textContent = text; $('message').className = error ? 'error' : ''; }
async function action(fn) { try { await fn(); await refresh(); } catch (error) { message(error.message, true); } }
function element(tag, text, className) { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; }

function when(value) {
  const date = new Date(value);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function viewShots(run) {
  return action(async () => {
    const images = await window.farm.image(run.id);
    if (!images?.length) throw new Error('Screenshot is no longer available.');
    $('shots').replaceChildren(...images.map(src => {
      const img = document.createElement('img');
      img.src = src;
      img.alt = `${run.parameter || 'Run'} capture`;
      return img;
    }));
    $('imageDialog').showModal();
  });
}

function detailFor(run) {
  if (!run) return [element('p', 'Select a run to see its details.', 'detail-empty')];
  const heading = element('h3', '');
  heading.append(element('span', run.parameter || '—', 'mono'), document.createTextNode(` · PR #${run.pr || '—'}`));
  const nodes = [heading];
  const list = document.createElement('dl');
  const add = (term, value, bad = false) => {
    if (!value) return;
    list.append(element('dt', term), element('dd', value, bad ? 'bad' : ''));
  };
  const addLink = (term, url) => {
    if (!url) return;
    const link = element('a', url, 'link');
    link.href = url;
    link.onclick = event => { event.preventDefault(); action(() => window.farm.open(url)); };
    const value = document.createElement('dd');
    value.append(link);
    list.append(element('dt', term), value);
  };
  add('Status', run.status);
  add('Progress', run.step);
  add(run.error ? 'Error' : '', run.error, true);
  add('Publishing', run.publishError, true);
  add('Commit', run.sha);
  add('Author', run.author ? `@${run.author}` : '');
  add('Received', new Date(run.createdAt).toLocaleString());
  add('Parts', run.screenshots?.length > 1 ? String(run.screenshots.length) : '');
  add('Build', run.built === true ? 'Built for this commit' : run.built === false ? 'Reused an existing build' : '');
  addLink('Trigger', run.commentUrl);
  addLink('Result', run.resultCommentUrl);
  nodes.push(list);

  const actions = element('div', '', 'actions');
  if (run.status === 'failed' && run.screen) {
    const retry = element('button', 'Retry Same Commit');
    retry.onclick = () => action(() => window.farm.retry(run.id));
    actions.append(retry);
  }
  if (run.screenshot) {
    const count = run.screenshots?.length || 1;
    const view = element('button', count > 1 ? `View ${count} Parts` : 'View Screenshot', 'default');
    view.onclick = () => viewShots(run);
    const reveal = element('button', 'Show in Finder');
    reveal.onclick = () => action(() => window.farm.reveal(run.id));
    actions.append(view, reveal);
  }
  if (actions.childElementCount) nodes.push(actions);
  return nodes;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await window.farm.state();
    $('screenExamples').replaceChildren();
    // Both projects answer the same commands, so the list is their union.
    const screens = [...new Map(state.projects.flatMap(p => p.screens).map(s => [s.id, s])).values()];
    for (const screen of screens) {
      const button = element('button', '');
      button.type = 'button';
      button.className = screenFilter === screen.id ? 'selected' : '';
      const alternates = screen.aliases.slice(1);
      const label = element('span', '', 'name');
      label.append(
        element('span', screen.aliases[0], 'cmd'),
        element('span', alternates.length ? `${screen.name} · or ${alternates.join(', ')}` : screen.name, 'alt')
      );
      button.append(label, element('span', String(state.runs.filter(run => run.screen?.id === screen.id).length), 'badge'));
      button.onclick = () => { screenFilter = screen.id; refresh(); };
      $('screenExamples').append(button);
    }
    $('status').textContent = state.lastError ? 'Connection Error' : state.listening ? 'Listening' : state.running ? 'Finishing Capture' : 'Paused';
    $('statusDot').className = `dot ${state.lastError ? 'error' : state.listening ? 'live' : ''}`;
    $('listen').querySelector('.tool-label').textContent = state.listening ? 'Pause Listening' : 'Start Listening';
    $('listen').classList.toggle('listening', state.listening);
    $('count').textContent = state.runs.length;
    $('poll').disabled = !state.listening || state.polling;
    $('lastPoll').textContent = state.lastPollAt ? `Last checked ${new Date(state.lastPollAt).toLocaleTimeString()}` : 'Not checked yet';
    if (state.lastError) { message(state.lastError, true); connectionErrorShown = true; }
    else if (connectionErrorShown) { message(''); connectionErrorShown = false; }
    else if (state.notice) message(state.notice);

    const ordered = [...state.runs].reverse().filter(run => !screenFilter || run.screen?.id === screenFilter);
    if (!ordered.some(run => run.id === selectedId)) selectedId = ordered[0]?.id ?? null;
    $('navRuns').classList.toggle('selected', !screenFilter);
    $('empty').hidden = ordered.length > 0;
    $('empty').querySelector('.empty-title').textContent = screenFilter ? 'No Runs for This Command' : 'No Runs Yet';

    $('runs').replaceChildren();
    for (const run of ordered) {
      const row = document.createElement('tr');
      if (run.id === selectedId) row.className = 'selected';
      row.append(
        element('td', run.status, `state ${run.status}`),
        element('td', run.parameter || '—', run.parameter ? 'mono' : 'mono muted'),
        element('td', run.device || '—', 'mono muted'),
        element('td', run.pr ? `#${run.pr}` : '—', 'muted'),
        element('td', run.sha?.slice(0, 7) || '—', 'mono muted'),
        element('td', run.author ? `@${run.author}` : '—', 'muted'),
        element('td', when(run.createdAt), 'muted')
      );
      row.onclick = () => { selectedId = run.id; refresh(); };
      row.ondblclick = () => { if (run.screenshot) viewShots(run); };
      $('runs').append(row);
    }
    $('detail').replaceChildren(...detailFor(ordered.find(run => run.id === selectedId)));
    $('runs').querySelector('tr.selected')?.scrollIntoView({ block: 'nearest' });
  } finally { refreshing = false; }
}

$('tableWrap').onkeydown = event => {
  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  event.preventDefault();
  const ordered = [...state.runs].reverse().filter(run => !screenFilter || run.screen?.id === screenFilter);
  const next = ordered[ordered.findIndex(run => run.id === selectedId) + step];
  if (next) { selectedId = next.id; refresh(); }
};
// Whether the sidebar is showing is a view preference, so it lives with the window.
function applySidebar() {
  const hidden = localStorage.getItem('sidebarHidden') === '1';
  document.body.classList.toggle('sidebar-hidden', hidden);
  $('toggleSidebar').setAttribute('aria-pressed', String(!hidden));
  window.farm.reportSidebar(hidden);
}
function toggleSidebar() {
  localStorage.setItem('sidebarHidden', localStorage.getItem('sidebarHidden') === '1' ? '0' : '1');
  applySidebar();
}
$('toggleSidebar').onclick = toggleSidebar;
window.farm.onToggleSidebar(toggleSidebar);
applySidebar();

$('navRuns').onclick = () => { screenFilter = null; refresh(); };
$('navRuns').onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('navRuns').click(); } };
$('listen').onclick = () => action(async () => { message(''); if (state.listening) await window.farm.stop(); else await window.farm.start(); });
$('poll').onclick = () => action(async () => { message(''); await window.farm.poll(); });
$('closeImage').onclick = () => $('imageDialog').close();
window.farm.onChange(() => refresh().catch(error => message(error.message, true)));
refresh().catch(error => message(error.message, true));

// ---------- Column resize ----------
// Column widths are a view preference, so they live with the window the way the
// sidebar does, and the handle answers the keyboard as well as the mouse.
(function initColResize() {
  const MIN_W = 40;
  const STEP = 16;
  const stored = JSON.parse(localStorage.getItem('columnWidths') || '{}');
  const handles = [...document.querySelectorAll('table.runs thead th .col-resize-handle')];

  const column = handle => handle.closest('th');
  const key = handle => column(handle).className;
  const save = () => localStorage.setItem('columnWidths', JSON.stringify(
    Object.fromEntries(handles.map(h => [key(h), column(h).style.width]).filter(([, width]) => width))));
  const resize = (handle, width) => { column(handle).style.width = `${Math.max(MIN_W, width)}px`; };

  for (const handle of handles) {
    if (stored[key(handle)]) column(handle).style.width = stored[key(handle)];
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', `Resize the ${column(handle).firstChild.textContent} column`);

    handle.addEventListener('keydown', event => {
      const step = { ArrowLeft: -STEP, ArrowRight: STEP }[event.key];
      if (step === undefined) return;
      event.preventDefault();
      resize(handle, column(handle).offsetWidth + step);
      save();
    });

    handle.addEventListener('mousedown', event => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = column(handle).offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const onMove = move => resize(handle, startWidth + move.clientX - startX);
      const onUp = () => {
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        save();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
})();
