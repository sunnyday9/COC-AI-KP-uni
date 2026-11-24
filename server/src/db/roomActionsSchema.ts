// The receipt is kept for the room's lifetime, including after the author leaves.
export const ROOM_ACTIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS room_actions (
    room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    action_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    message_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled')),
    PRIMARY KEY (room_id, user_id, action_id)
  );
`
