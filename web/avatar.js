// Agent 头像：一个形状加一双眼睛，状态靠眼神和动作表达，不另外加状态灯。
// 只输出固定的 SVG 片段；名字等外部文字由调用方转义后放进 label。

const MOODS = {
  running: 'work',
  waiting_approval: 'ask', waiting_input: 'ask',
  completed: 'done', accepted: 'done', replied: 'done',
  failed: 'fail', error: 'fail',
  idle: 'idle', ready: 'idle', connected: 'idle',
  starting: 'wake', connecting: 'wake', interrupt_requested: 'wake', queued: 'wake',
};
/** 把成员、会话或任务的状态归成六种神态：idle work ask done fail wake，其余都算睡着。 */
export const mood = state => MOODS[state] || 'sleep';

/** 来源标签（Claude Code、Codex、网页 AI）对应的头像种类。 */
export const kindOf = label => /claude/i.test(label) ? 'claude' : /codex|cx/i.test(label) ? 'codex' : 'web';

// 原生成员没有固定身份，按编号挑一个安静的颜色，同一个成员每次都一样。
const TINTS = ['#3F5B73', '#566B4B', '#6A4F78', '#7A5A3D', '#3D6966', '#6B5560'];
const tint = id => TINTS[[...String(id)].reduce((sum, c) => sum + c.charCodeAt(0), 0) % TINTS.length];

const BODY = {
  codex: '<rect class="body" x="4" y="5" width="24" height="23" rx="8"></rect>',
  claude: '<path class="body" d="M16 4.5c6.9 0 12 4.6 12 11.3 0 6.9-5 12.2-12 12.2S4 22.7 4 15.8C4 9.1 9.1 4.5 16 4.5Z"/>',
  web: '<rect class="body" x="5" y="5" width="22" height="22" rx="11"></rect>',
  agent: '<rect class="body" x="4.5" y="5.5" width="23" height="22" rx="10"></rect>',
};
const EYES = `<g class="eyes">
  <g class="e-open"><rect x="10.5" y="12" width="3.4" height="6.4" rx="1.7"></rect><rect x="18.1" y="12" width="3.4" height="6.4" rx="1.7"></rect></g>
  <g class="e-happy" fill="none" stroke-width="2" stroke-linecap="round"><path d="M10 16.4q2.2-3 4.4 0"/><path d="M17.6 16.4q2.2-3 4.4 0"/></g>
  <g class="e-shut" fill="none" stroke-width="1.8" stroke-linecap="round"><path d="M10.4 15.6h3.6"/><path d="M18 15.6h3.6"/></g>
  <g class="e-x" fill="none" stroke-width="1.7" stroke-linecap="round"><path d="M10.6 13.2l3.2 3.6M13.8 13.2l-3.2 3.6"/><path d="M18.2 13.2l3.2 3.6M21.4 13.2l-3.2 3.6"/></g>
</g>`;

/**
 * kind: codex | claude | web | agent；state 见 mood()；label 必须已转义；id 只用于给原生成员挑颜色。
 */
export function avatar(kind, state, { size = 28, label = '', id = '' } = {}) {
  const k = BODY[kind] ? kind : 'web';
  return `<span class="av av-${k}" data-mood="${mood(state)}" style="${avatarStyle(k, size, id)}"${label ? ` role="img" aria-label="${label}" title="${label}"` : ' aria-hidden="true"'}>${avatarSvg(k)}</span>`;
}
/** 给自己建元素的模块用：外层 span 由调用方建，之后只改 data-mood，动画不会被重绘打断。 */
export const avatarSvg = kind => `<svg viewBox="0 0 32 32"><circle class="halo" cx="16" cy="16.3" r="14.5"></circle>${BODY[kind] ?? BODY.web}${EYES}</svg>`;
export const avatarStyle = (kind, size, id = '') => `--av:${size}px${kind === 'agent' ? `;--av-body:${tint(id)}` : ''}`;
