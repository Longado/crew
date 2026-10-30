PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT,
  created_at TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,     -- 暂停采集：不再读新对话，已有数据保留
  remote_ok INTEGER NOT NULL DEFAULT 0   -- 已同意把对话正文发给远程模型整理
);

CREATE TABLE IF NOT EXISTS project_dirs (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dir TEXT NOT NULL,
  PRIMARY KEY (project_id, dir)
);

-- project_id 为空的会话是待归类；删项目时它的会话、消息一起删
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  label TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  cwd TEXT,
  title TEXT,
  coverage TEXT NOT NULL DEFAULT 'full',
  file TEXT,
  cursor INTEGER NOT NULL DEFAULT 0,       -- 源文件已读到的字节位置
  extracted_upto INTEGER NOT NULL DEFAULT -1 -- 已整理到的消息序号
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  ts TEXT,
  captured_at TEXT NOT NULL,
  skipped_by_since INTEGER NOT NULL DEFAULT 0 -- 被 since 跳过、尚未发给模型
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  goal TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  cite TEXT NOT NULL,
  speaker TEXT NOT NULL,
  detail TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL,
  ord INTEGER NOT NULL,
  downgraded TEXT,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  batch_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project_id);

-- 同一批消息、同一提示词版本、同一模型只整理一次，重跑不重复写入
CREATE TABLE IF NOT EXISTS batches (
  key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  upto_seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS corrections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  body TEXT NOT NULL
);

-- 工具自己记录使用情况，试用阶段直接看数
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  at TEXT NOT NULL
);
