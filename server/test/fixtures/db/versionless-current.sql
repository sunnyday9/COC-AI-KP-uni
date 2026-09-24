-- Current tables created by the old ad-hoc initializer, but without user_version.
CREATE TABLE stories (
  user_id INTEGER NOT NULL,
  story_id TEXT NOT NULL,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, story_id)
);
CREATE TABLE rooms (
  room_id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  story_id TEXT,
  kind TEXT NOT NULL DEFAULT 'multi',
  phase TEXT NOT NULL DEFAULT 'lobby',
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE room_members (
  room_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  character_id TEXT,
  ready INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE kp_wire_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  turn_seq INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  story_id TEXT,
  rag_context TEXT NOT NULL DEFAULT '',
  tool_calls TEXT NOT NULL DEFAULT '[]',
  wire_messages TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_kp_wire_samples_room ON kp_wire_samples (room_id);
CREATE UNIQUE INDEX uq_kp_wire_samples_room_seq ON kp_wire_samples (room_id, turn_seq);

INSERT INTO stories (user_id, story_id, name, file_path, created_at)
VALUES (12, 'story-current', 'Current story', '/legacy/story.txt', 200);
