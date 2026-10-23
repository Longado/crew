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
  const card = (item, index) => `<article class="today-card">
    <div class="today-card-top"><span class="s">${escape(item.projectName)}${item.sourceId ? ` · #${escape(item.sourceId)}` : ''}</span><span class="chip c-${escape(item.status)}">${escape(statuses[item.status])}</span></div>
    <h3>${index === undefined ? '' : `<span class="today-order">${index + 1}</span>`}${escape(item.name)}</h3>
    ${item.sourceKind === 'workspace' ? `<p class="s">来源状态 · 更新于 ${escape(item.sourceUpdatedAt || '时间不明')} · 优先级：${escape(priorities[item.priority] || '未设定')}${item.dueDate ? ` · 截止 ${escape(item.dueDate)}` : ''}</p>` : ''}
    <dl><dt>为什么</dt><dd>${escape(item.reason)}</dd>
      <dt>下一步</dt><dd>${escape(item.action)}</dd>
      <dt>等待条件</dt><dd>${escape(item.precondition === '无' ? '无已知等待条件' : item.precondition)}</dd>
      <dt>完成条件</dt><dd>${escape(item.doneStandard)}</dd></dl>
  </article>`;
  const group = (title, items, none, numbered = false) => `<section class="today-group"><h2>${title}<span class="s"> ${items.length} 项</span></h2>
    ${items.length ? `<div class="today-cards">${items.map((item, index) => card(item, numbered ? index : undefined)).join('')}</div>` : `<p class="s">${none}</p>`}</section>`;
  function draw() {
    if (!alive) return;
    if (staticDemo) {
      root.innerHTML = '<section class="crew-today"><h1>今日安排</h1><p>今日安排需要本机任务来源。当前是只读演示，没有加载个人任务。</p></section>';
      return;
    }
    root.innerHTML = `<section class="crew-today">
      <div class="head"><div><h1>今日安排</h1><p class="sub">${data ? `${escape(data.date)} · ${escape(data.timeZone)}` : '搜索已有任务中…'}</p></div>
        <button class="btn" data-today-refresh ${busy ? 'disabled' : ''}>搜索并更新安排</button></div>
      <p class="today-source">任务来源：${escape(data?.source.label || '读取配置中…')}。</p>
      <p class="s">配置外部来源后，打开此页时刷新并保存只读快照。同类任务先看截止日期、优先级，再参考已有规划；最多建议三项。只整理安排，不自动执行任务。</p>
      <form data-today-form="search" class="today-search"><fieldset><label>搜索任务<input name="query" maxlength="100" value="${escape(query)}" placeholder="任务关键词、项目名或 #编号"></label><button class="btn" type="submit">搜索快照</button></fieldset></form>
      <p data-today-feedback role="status" aria-live="polite"></p>
      ${data ? `<p class="s">共 ${data.totalTasks} 项 · 当前匹配 ${data.matchingTasks} 项。暂停、归档、结束项目及超过 14 天未更新的任务先核对，再决定是否安排。</p>
      ${!data.source.configured ? '<div class="banner">尚未配置外部任务来源，仅展示 Crew 本地任务。</div>' : ''}
      ${data.totalTasks === 0 ? `<div class="empty">${data.source.configured ? '还没有可用任务快照。点击“搜索并更新安排”读取已登记的任务。' : '当前 Crew 本地任务库还没有任务。'}</div>` : ''}
      ${data.totalTasks > 0 && data.matchingTasks === 0 ? '<div class="empty">没有匹配的任务。可换一个关键词，或清空搜索查看全部。</div>' : ''}
      ${group('优先建议 · 最多三项', data.suggested, '当前没有可直接推进的建议。', true)}
      ${group('受阻 · 先处理等待条件', data.blocked, '没有记录为受阻的任务。')}
      ${group('先核对再安排', data.pending, '没有需要先核对的事项。')}
      ${group('其余可推进任务', data.remaining, '没有其他待推进任务。')}
      ${data.completed.length ? group('今日本地确认完成', data.completed, '') : ''}
      <p class="s">快照更新：${escape(data.source.refreshedAt ? new Date(data.source.refreshedAt).toLocaleString('zh-CN', { timeZone: data.timeZone }) : '尚无来源快照')}。外部任务库已完成、已取消任务不录入；页面不回写外部任务库。</p>` : ''}
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
      await readSaved();
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
