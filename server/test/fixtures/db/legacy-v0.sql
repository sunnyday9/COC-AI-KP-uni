-- Representative versionless database before the ad-hoc column additions.
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE settings (
  user_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE stories (
  user_id INTEGER NOT NULL,
  story_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, story_id)
);
CREATE TABLE rooms (
  room_id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  story_id TEXT,
  phase TEXT NOT NULL DEFAULT 'lobby',
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sheet TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE room_members (
  room_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  character_id TEXT,
  PRIMARY KEY (room_id, user_id)
);

INSERT INTO users (id, username, password_hash, created_at) VALUES (11, 'legacy-user', 'hash', 100);
INSERT INTO stories (user_id, story_id, name, created_at) VALUES (11, 'story-old', 'Old story', 101);
INSERT INTO rooms (room_id, owner_id, invite_code, story_id, phase, state, version, updated_at, created_at)
VALUES ('room-old', 11, 'invite-old', 'story-old', 'playing', '{}', 3, 102, 99);
INSERT INTO room_members (room_id, user_id, role, character_id)
VALUES ('room-old', 11, 'owner', NULL);
