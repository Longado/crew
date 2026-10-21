'use strict';
(() => {
  const list = document.getElementById('lead-runs-list');
  if (!list) return;
  const status = document.getElementById('lead-runs-status');
  const labels = {ready:'可派', waiting:'等待依赖', running:'执行中', stalled:'停滞', delivered:'待验收', accepted:'已验收', rejected:'已退回', stale:'验收失效', lost:'看守失联', failed:'失败', timed_out:'超时', stopped:'已停止', blocked:'缺输入', partial:'部分交付'};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const label = value => esc(labels[value] || value || '未验收');
  const duration = seconds => seconds == null ? '未知' : `${Math.floor(seconds / 60)}分 ${Math.floor(seconds % 60)}秒`;
  let previous = '';
  function card(row, directory) {
    const review = row.review || {};
    const conclusion = row.conclusion ? `<details class="lead-conclusion" data-lead-key="${esc(directory + '/' + row.card)}"><summary>${review.verdict ? '结论卡摘要' : '新交回 · 结论卡摘要'}</summary><pre>${esc(row.conclusion)}</pre>${row.output ? `<p class="lead-path">完整交付：${esc(row.output)}</p>` : ''}</details>` : '';
    const activity = ['running', 'stalled'].includes(row.state) ? `最后动静距今：${duration(row.idle_seconds)}` : '';
    const output = row.last_output ? `<p class="lead-last-output">${esc(row.last_output)}</p>` : '';
    return `<tr><th scope="row">${esc(row.card)}</th><td>${label(row.state)}</td><td>${duration(row.seconds)}</td><td>${row.tokens == null ? '未知' : esc(row.tokens.toLocaleString())}</td><td class="lead-progress">${activity}${output || (activity ? '<p>尚无输出</p>' : '—')}</td><td>${label(review.verdict)}${review.note ? '：' + esc(review.note) : ''}${conclusion}</td></tr>`;
  }
  function run(row) {
    const body = row.status === 'moved' ? '<p class="lead-warning">已移走</p>' : row.status === 'error' ? `<p class="lead-warning">${esc(row.error)}</p>` : row.cards.length ? `<div class="lead-table-wrap"><table><thead><tr><th>卡片</th><th>状态</th><th>已跑多久</th><th>本次 tokens</th><th>最后动静／输出</th><th>验收结论／交付摘要</th></tr></thead><tbody>${row.cards.map(c => card(c, row.dir)).join('')}</tbody></table></div>` : '<p>暂无任务卡。</p>';
    return `<article class="lead-run"><h3>${esc(row.goal || '未填写目标')}</h3><p class="lead-path">${esc(row.dir)}</p><p class="lead-created">创建：${esc(row.created_at || '未知')}</p>${body}</article>`;
  }
  async function refresh() {
    try {
      const response = await fetch('/api/lead-runs', {cache:'no-store'});
      if (!response.ok) throw new Error('读取失败');
      const data = await response.json();
      const html = data.runs.map(run).join('');
      if (html !== previous) {
        const opened = new Set([...list.querySelectorAll('details[open]')].map(d => d.dataset.leadKey));
        list.innerHTML = html;
        list.querySelectorAll('details').forEach(d => { d.open = opened.has(d.dataset.leadKey); });
        previous = html;
      }
      document.getElementById('lead-runs-count').textContent = ` ${data.runs.length}`;
      status.textContent = data.runs.length ? '' : '暂无负责人运行；首次 worker run 后会自动出现在这里。';
    } catch {
      status.textContent = '暂时无法读取负责人运行，稍后自动重试；已有内容可能不是最新状态。';
    } finally {
      window.setTimeout(refresh, 3000);
    }
  }
  refresh();
})();
