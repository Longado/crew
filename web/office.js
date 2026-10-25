// 虚拟办公室：每个来源一张桌子。谁最后推动了某个任务，任务就摆在谁桌上；
// 状态全部从证据折叠结果里来，画面只是另一种读法，不另存状态。
// 只输出固定结构的 HTML，任务名、来源名、原话这类外部文字一律经过 esc()。
import { avatar, kindOf } from './avatar.js';
import L from './office/layout.js'; // 场景图里白板、桌位、收件盘的像素位置，由 scripts/office/render.py 生成

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (id) => String(id).split('/').pop();
const MAX_DESKS = 5;
const SLEEP_AFTER = 3 * 86400000; // 比项目里最近的动静早三天以上没出声，就算睡着

/** 移动过的会话标签带“（从「…」移来）”，同一个来源要坐回同一张桌子。 */
const seatName = (label) => String(label).replace(/（从「.*」移来）$/, '');


/** 算出每张桌子：谁、在做什么、有没有等你的事。纯函数，测试和画面共用。 */
export function seats({ view, sessions, evidence }) {
  const desks = new Map();
  for (const s of sessions) {
    const name = seatName(s.label);
    if (!desks.has(name)) desks.set(name, { name, kind: kindOf(name), selfReport: false, asks: [], blocks: [], doing: [], done: [], last: 0 });
    if (s.source === 'mcp') desks.get(name).selfReport = true;
  }
  // 证据的 session 由服务端从被引用的消息查出来，页面不猜消息编号的格式
  const label = new Map(sessions.map((s) => [s.id, seatName(s.label)]));
  const deskOf = (e) => e && desks.get(label.get(e.session));
  let latest = 0;
  for (const e of Object.values(evidence)) {
    const t = Date.parse(e.at);
    if (t > latest) latest = t;
    const desk = deskOf(e);
    if (desk && t > desk.last) desk.last = t;
  }
  for (const t of view.tasks) {
    if (t.status === 'cancelled') continue;
    // 任务最近一次变化发生在哪段对话，就摆在那段对话的来源桌上；人工改的没有出处，往前找
    const moved = [...t.history].reverse().map((h) => evidence[h.evidenceId]).find(Boolean);
    const desk = deskOf(moved);
    if (!desk) continue;
    const bucket = { to_verify: desk.asks, blocked: desk.blocks, doing: desk.doing, done: desk.done }[t.status];
    bucket?.push(t);
  }
  return [...desks.values()].map((d) => {
    const state = d.asks.length || d.blocks.length ? 'waiting_approval' : d.doing.length ? 'running' : latest && d.last && latest - d.last > SLEEP_AFTER ? 'closed' : 'idle';
    return { ...d, state };
  });
}

const seen = (t) => new Date(t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' ';

// 场景图上的像素换成百分比，图怎么缩放，叠上去的东西都跟着
const [SW, SH] = L.size;
const pct = (v, of) => `${+(v / of * 100).toFixed(3)}%`;
const at = ([x, y]) => `left:${pct(x, SW)};top:${pct(y, SH)}`;
const box = ([x, y, w, h]) => `${at([x, y])};width:${pct(w, SW)};height:${pct(h, SH)}`;
// 白板在斜着的后墙上：左上角定位，按上沿的斜率把便签一起斜切过去
const [TL, TR, BL] = L.board;
const boardStyle = `${box([TL[0], TL[1], TR[0] - TL[0], BL[1] - TL[1]])};--skew:${+(Math.atan2(TR[1] - TL[1], TR[0] - TL[0]) * 180 / Math.PI).toFixed(2)}deg`;
const EYES = (L.faceR * 2 * 32) / 24; // avatar.js 的身子占 32 格画布里的 24 格

function bubble(d, last, pos) {
  if (d.asks.length) return `<span class="bubble b-ask" style="${pos}"><i></i>请验收<b>${esc(d.asks[0].name)}</b>${d.asks.length > 1 ? `<em>+${d.asks.length - 1}</em>` : ''}</span>`;
  if (d.blocks.length) return `<span class="bubble b-block" style="${pos}"><i></i>卡住<b>${esc(d.blocks[0].blocker ?? d.blocks[0].name)}</b></span>`;
  if (last && seatName(last.label) === d.name) return `<span class="bubble b-say" style="${pos}">${esc(last.text)}</span>`;
  return '';
}

function pop(d, i, pid, last) {
  const row = (t, tag) => `<a class="pop-t" href="#/p/${esc(pid)}/task/${esc(short(t.id))}"><span class="pop-k k-${t.status}">${tag}</span>${esc(t.name)}</a>`;
  const rows = [...d.asks.map((t) => row(t, '请验收')), ...d.blocks.map((t) => row(t, '卡住')), ...d.doing.map((t) => row(t, '在做')), ...d.done.slice(-2).map((t) => row(t, '已完成'))];
  const said = last && seatName(last.label) === d.name ? `<blockquote class="pop-said">${esc(last.text)}</blockquote>` : '';
  const go = d.doing[0] ?? d.blocks[0] ?? d.asks[0];
  // 卡片开在头像旁边：左边三张桌往右开，右边两张往左开，不压住头顶的气泡和屋外的页面标题
  return `<div class="pop${i >= 3 ? ' pop-r' : ''}" role="dialog" aria-label="${esc(d.name)}" style="${at(L.slots[i].face)}" hidden>
    <div class="pop-h">${avatar(d.kind, d.state, { size: 26 })}<b>${esc(d.name)}</b><span class="pop-src">${d.selfReport ? '自己报到' : '从对话整理'}</span></div>
    ${said}
    ${rows.length ? `<div class="pop-list">${rows.join('')}</div>` : '<p class="pop-none">桌上没有进行中的任务</p>'}
    ${go ? `<button class="btn sm" data-act="cont" data-task="${esc(go.id)}">继续「${esc(go.name)}」</button>` : ''}
  </div>`;
}

/** 一张桌子是盖在整张场景上的一层：身子和眼睛坐在桌后，气泡在头顶，名牌在桌前地上，点桌子弹卡片。 */
function desk(d, i, pid, last) {
  const now = d.doing[0];
  const slot = L.slots[i];
  const [bx, by, bw, bh] = L.body[d.kind] ?? L.body.web;
  const label = `${d.name}：${d.asks.length ? `${d.asks.length} 件请你验收` : d.blocks.length ? '卡住了，等你' : now ? `在做「${now.name}」` : d.state === 'closed' ? '有一阵没动静' : '空闲'}`;
  return `<div class="desk" data-mood-state="${d.state}" data-asks="${esc([...d.asks, ...d.blocks].map((t) => t.id).join(' '))}" style="--i:${i}">
    <button class="desk-hit" type="button" data-desk="${i}" aria-haspopup="dialog" aria-label="${esc(label)}" style="${box(slot.hit)}"></button>
    <span class="who" aria-hidden="true">
      <i class="o-body ob-${d.kind}" style="${box([slot.face[0] + bx, slot.face[1] + by, bw, bh])}"></i>
      <span class="o-eyes" style="${at(slot.face)};width:${pct(EYES, SW)}">${avatar(d.kind, d.state)}</span>
    </span>
    ${bubble(d, last, at(slot.head))}
    <span class="plate" style="${at(slot.label)}"><b>${esc(d.name)}</b><small>${now ? esc(now.name) : d.last ? `${seen(d.last)}来过` : '还没来过'}</small></span>
    ${pop(d, i, pid, last)}
  </div>`;
}

/** 办公室整体：预渲染的屋子（浅色白天、深色夜里），上面叠白板便签（规划）、完成数、桌子和你的收件盘。 */
export function officeHtml(data, pid, { asks = 0, staticDemo = false } = {}) {
  const { view } = data;
  const all = seats(data);
  const shown = all.slice(0, MAX_DESKS);
  const plan = view.plan.versions.at(-1);
  const status = new Map(view.tasks.map((t) => [t.id, t.status]));
  const notes = plan ? plan.items.filter((it) => it.change !== 'cancelled') : [];
  const done = view.tasks.filter((t) => t.status === 'done');
  const last = view.lastPosition;
  return `<section class="office" aria-label="办公室">
    <div class="scene" style="aspect-ratio:${SW}/${SH}">
      <a class="board" href="#/p/${esc(pid)}/plan" style="${boardStyle}" aria-label="${plan ? `规划第 ${plan.n} 版，${notes.length} 项` : '还没有规划'}">
        <span class="board-h">${plan ? `第 ${plan.n} 版规划` : '还没有规划'}</span>
        <span class="stickies">${notes.slice(0, 6).map((it, k) => `<span class="note n-${status.get(it.taskId) ?? 'todo'}" style="--r:${(k % 3) - 1}">${esc(it.name)}</span>`).join('')}${notes.length > 6 ? `<span class="note n-more">+${notes.length - 6}</span>` : ''}</span>
      </a>
      <span class="shelf-l" style="${at(L.shelf)}" title="${esc(done.map((t) => t.name).join('、'))}">完成 <b>${done.length}</b></span>
      ${shown.map((d, i) => desk(d, i, pid, last)).join('')}
      ${all.length > MAX_DESKS ? `<span class="more-desks">还有 ${all.length - MAX_DESKS} 位</span>` : ''}
      <button class="tray" type="button" data-tray style="${box(L.trayHit)}" aria-label="等你处理 ${asks} 件">
        <span class="papers">${Array.from({ length: Math.min(asks, 5) }, (_, k) => `<i style="--k:${k}"></i>`).join('')}</span>
        <span class="tray-l">等你<b>${asks}</b></span>
      </button>
    </div>
    ${staticDemo ? '' : `<button class="join" type="button" data-act="mcp-join">${all.some((d) => d.selfReport) ? 'Agent 报到方式' : '让 Agent 自己报到'}</button>`}
  </section>`;
}

/** 打开过的“等你”记在本机，下次进门只让新交上来的那几件飞到收件盘。 */
const seenKey = (pid) => `crew:office-seen:${pid}`;

/** 绑定桌子弹出卡、收件盘和“新交的活飞过来”的动画。返回清理函数。 */
export function wireOffice(root, { pid, askIds = [], onTray = () => {} } = {}) {
  const office = root.querySelector('.office');
  if (!office) return () => {};
  const close = () => office.querySelectorAll('.pop:not([hidden])').forEach((p) => { p.hidden = true; p.closest('.desk').classList.remove('open'); });
  const click = (e) => {
    const hit = e.target.closest('.desk-hit');
    if (hit) {
      const p = hit.parentElement.querySelector('.pop');
      const wasOpen = !p.hidden;
      close();
      if (!wasOpen) { p.hidden = false; hit.parentElement.classList.add('open'); }
      return;
    }
    if (e.target.closest('[data-tray]')) { close(); onTray(); return; }
    if (!e.target.closest('.pop')) close();
  };
  const key = (e) => { if (e.key === 'Escape') close(); };
  office.addEventListener('click', click);
  document.addEventListener('keydown', key);
  const outside = (e) => { if (!office.contains(e.target)) close(); };
  document.addEventListener('click', outside);

  let seen = null;
  try { seen = JSON.parse(localStorage.getItem(seenKey(pid)) ?? 'null'); } catch {}
  const fresh = askIds.filter((id) => !(seen ?? []).includes(id));
  try { localStorage.setItem(seenKey(pid), JSON.stringify(askIds)); } catch {}
  if (fresh.length && !matchMedia('(prefers-reduced-motion: reduce)').matches) fly(office, fresh);
  return () => { office.removeEventListener('click', click); document.removeEventListener('keydown', key); document.removeEventListener('click', outside); };
}

/** 一张纸从交活的那张桌子飞进收件盘。找不到是谁交的（比如桌子太多没摆出来），就从办公室中间起飞。 */
function fly(office, ids) {
  const scene = office.querySelector('.scene');
  const tray = scene.querySelector('.papers');
  const frame = scene.getBoundingClientRect();
  const to = tray.getBoundingClientRect();
  const desks = [...scene.querySelectorAll('.desk')];
  ids.slice(0, 3).forEach((id, k) => {
    const desk = desks.find((d) => d.dataset.asks.split(' ').includes(id));
    const from = (desk?.querySelector('.o-eyes') ?? scene).getBoundingClientRect();
    const paper = document.createElement('i');
    paper.className = 'flying';
    scene.append(paper);
    const x0 = from.left - frame.left + from.width / 2, y0 = from.top - frame.top + from.height / 2;
    const x1 = to.left - frame.left + to.width / 2, y1 = to.top - frame.top + to.height / 2;
    const mid = Math.min(y0, y1) - 70;
    paper.animate([
      { transform: `translate(${x0}px,${y0}px) rotate(-8deg) scale(.7)`, opacity: 0 },
      { transform: `translate(${(x0 + x1) / 2}px,${mid}px) rotate(14deg) scale(1)`, opacity: 1, offset: .5 },
      { transform: `translate(${x1}px,${y1}px) rotate(-4deg) scale(.85)`, opacity: 1 },
    ], { duration: 800, delay: 500 + k * 180, easing: 'cubic-bezier(.3,.1,.3,1)', fill: 'both' }).finished.then(() => {
      paper.remove();
      tray.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(3px)' }, { transform: 'translateY(0)' }], { duration: 260 });
    });
  });
}
