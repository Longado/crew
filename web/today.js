const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const statuses = { todo: '待开始', doing: '进行中', to_verify: '待验收', blocked: '受阻', pending_confirm: '待确认', done: '已完成' };
const priorities = { urgent: '紧急', high: '高', medium: '中', low: '低' };

export function mountToday(root, { api, staticDemo = false } = {}) {
  let alive = true, busy = false, data = null, query = '';
  const feedback = message => {
    if (!alive) return;
    const element = root.querySelector('[data-today-feedback]');
    if (element) element.textContent = message;
  };
  const setBusy = value => {
    busy = value;
    if (!alive) return;
    root.querySelectorAll('fieldset, button[data-today-refresh]').forEach(element => { element.disabled = value; });
  };
  // Repeated text is said once: a next step that only restates the title is dropped, and a field shared by every item in a group moves to the group heading.
  const fields = [['reason', '为什么'], ['action', '下一步'], ['precondition', '等待条件'], ['doneStandard', '完成条件']];
  const empty = (item, key) => key === 'action' ? !item.action || item.action.includes(item.name) : key === 'precondition' && item.precondition === '无';
  const sharedValue = (items, key) => items.length > 1 && items.every(item => item[key] === items[0][key]) ? items[0][key] : undefined;
  const sourceLine = item => item.sourceKind === 'workspace' ? `<p class="s">来源状态 · 更新于 ${escape(item.sourceUpdatedAt || '时间不明')} · 优先级：${escape(priorities[item.priority] || '未设定')}${item.dueDate ? ` · 截止 ${escape(item.dueDate)}${item.overdueDays ? `，已逾期 ${escape(item.overdueDays)} 天` : ''}` : ''}</p>` : '';
  const details = (item, shared) => `<dl>${fields.filter(([key]) => shared[key] === undefined && !empty(item, key))
    .map(([key, label]) => `<dt>${label}</dt><dd>${escape(item[key])}</dd>`).join('')}</dl>`;
  const card = (item, index, shared) => `<article class="today-card">
    <span class="today-order">${index + 1}</span>
    <div class="today-card-top"><span class="s">${escape(item.projectName)}${item.sourceId ? ` · #${escape(item.sourceId)}` : ''}</span><span class="chip c-${escape(item.status)}">${escape(statuses[item.status])}</span></div>
    <h3>${escape(item.name)}</h3>
    ${sourceLine(item)}
    ${details(item, shared)}
  </article>`;
  const row = (item, shared) => `<details class="today-row"><summary><span class="today-row-title">${escape(item.name)}</span><span class="s today-row-meta">${escape(item.projectName)}${item.sourceId ? ` · #${escape(item.sourceId)}` : ''}${item.dueDate ? ` · 截止 ${escape(item.dueDate)}${item.overdueDays ? `，已逾期 ${escape(item.overdueDays)} 天` : ''}` : ''}</span><span class="chip c-${escape(item.status)}">${escape(statuses[item.status])}</span></summary>
    ${sourceLine(item)}
    ${details(item, shared)}
  </details>`;
  const group = (title, items, none, cards = false) => {
    const shared = Object.fromEntries(fields.map(([key]) => [key, sharedValue(items, key)]));
    const notes = fields.filter(([key]) => shared[key] !== undefined && !empty(items[0], key)).map(([key, label]) => `${label}：${escape(shared[key])}`);
    return `<section class="today-group sec"><h2 class="sec-h">${title}<span class="n">${items.length}</span></h2>
    ${notes.length ? `<p class="today-shared">本组相同 · ${notes.join(' · ')}</p>` : ''}
    ${!items.length ? `<p class="none">${none}</p>` : cards ? `<div class="today-cards">${items.map((item, index) => card(item, index, shared)).join('')}</div>`
      : `<div class="today-rows">${items.map(item => row(item, shared)).join('')}</div>`}</section>`;
  };
  function draw() {
    if (!alive) return;
    if (staticDemo) {
      root.innerHTML = '<section class="crew-today"><header class="ph"><div class="ph-main"><h1>今日</h1><p class="ph-goal">今日安排需要本机任务来源。当前是只读演示，没有加载个人任务。</p></div></header></section>';
      return;
    }
    const rule = '截止日离今天 7 天以内（含刚逾期）的排在最前，越近越前；其余先看状态，再看截止日期、优先级；最多建议三项。只整理安排，不自动执行任务。';
    root.innerHTML = `<section class="crew-today">
      <header class="ph"><div class="ph-main"><h1>今日</h1><p class="ph-goal" title="${escape(rule)}">${data ? `${escape(data.date)} · ${escape(data.timeZone)} · 来源：${escape(data.source.label)}` : '搜索已有任务中…'}</p></div>
        <div class="ph-side"><button class="btn" data-today-refresh ${busy ? 'disabled' : ''}>更新安排</button></div></header>
      <form data-today-form="search" class="today-search"><fieldset><input name="query" maxlength="100" value="${escape(query)}" placeholder="搜索任务、项目名或 #编号" aria-label="搜索任务"><button class="btn" type="submit">搜索</button></fieldset></form>
      <p data-today-feedback role="status" aria-live="polite"></p>
      ${data ? `${!data.source.configured ? '<div class="banner">尚未配置外部任务来源，仅展示 Crew 本地任务。</div>' : ''}
      ${data.totalTasks === 0 ? `<div class="empty">${data.source.configured ? '还没有可用任务快照。点“更新安排”读取已登记的任务。' : '当前 Crew 本地任务库还没有任务。'}</div>` : ''}
      ${data.totalTasks > 0 && data.matchingTasks === 0 ? '<div class="empty">没有匹配的任务，换个关键词或清空搜索</div>' : ''}
      ${data.totalTasks > 0 ? `<p class="today-count" title="暂停、归档、结束项目及超过 14 天未更新的任务先核对，再决定是否安排">共 ${data.totalTasks} 项${query ? ` · 匹配 ${data.matchingTasks} 项` : ''}</p>` : ''}
      ${group('先做这几件', data.suggested, '当前没有可直接推进的建议。', true)}
      ${group('受阻', data.blocked, '没有记录为受阻的任务。')}
      ${group('先核对再安排', data.pending, '没有需要先核对的事项。')}
      ${group('其余可推进', data.remaining, '没有其他待推进任务。')}
      ${data.completed.length ? group('今天确认完成', data.completed, '') : ''}
      <p class="fine">快照更新：${escape(data.source.refreshedAt ? new Date(data.source.refreshedAt).toLocaleString('zh-CN', { timeZone: data.timeZone }) : '尚无来源快照')}。外部任务库已完成、已取消任务不录入；页面不回写外部任务库。</p>` : ''}
    </section>`;
    setBusy(busy);
  }
  const queryString = () => query ? `?q=${encodeURIComponent(query)}` : '';
  async function readSaved() {
    const result = await api('/api/today' + queryString());
    if (!alive) return;
    data = result; draw();
  }
  async function refresh() {
    try {
      const result = await api('/api/today/refresh' + queryString(), { method: 'POST', body: {} });
      if (!alive) return;
      data = result; draw();
    } catch (error) {
      if (!alive) return;
      try { await readSaved(); }
      catch (savedError) {
        feedback(`${error.message || '来源暂时无法读取'}。${savedError.message || '已保存的快照也无法读取'}`);
        return;
      }
      feedback(error.status === 409 ? error.message : `${error.message || '来源暂时无法读取'}。当前显示已保存的内容，请留意快照更新时间。`);
    }
  }
  async function run(action) {
    if (!alive || busy || staticDemo) return;
    setBusy(true); feedback('');
    try { await action(); }
    catch (error) { feedback(error.message || '操作未完成，请重试'); }
    finally { setBusy(false); }
  }
  root.onclick = event => {
    if (event.target.closest('[data-today-refresh]')) return run(refresh);
  };
  root.onsubmit = event => {
    if (event.target.dataset.todayForm !== 'search') return;
    event.preventDefault();
    return run(async () => {
      query = String(event.target.elements.namedItem('query')?.value ?? '').trim().slice(0, 100);
      await readSaved();
    });
  };
  draw();
  if (!staticDemo) void run(refresh);
  return () => { alive = false; root.onclick = null; root.onsubmit = null; };
}
