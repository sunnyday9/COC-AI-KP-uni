import { getPostgresPool, postgresError } from '../db/postgres.js'

type OutboxRow = { room_id: string; room_exists: boolean; members: string[]; seq: string | null; event_type: string | null; payload: unknown }

export async function readRoomOutbox(cursors: readonly { roomId: string; seq: number; userIds: number[] }[]): Promise<{
  roomId: string; roomExists: boolean; members: Set<number>; events: { seq: number; type: string; payload: unknown }[]
}[]> {
  try {
    const { rows } = await getPostgresPool().query<OutboxRow>(
      'WITH cursors AS (' +
      ' SELECT * FROM jsonb_to_recordset($1) AS c(room_id text, seq bigint, users jsonb)' +
      ') SELECT c.room_id, r.room_id IS NOT NULL AS room_exists, member_ids.members, e.seq, e.event_type, e.payload' +
      ' FROM cursors c LEFT JOIN rooms r USING (room_id)' +
      ' CROSS JOIN LATERAL (' +
      ' SELECT ARRAY(SELECT m.user_id::text FROM room_members m' +
      ' WHERE m.room_id = c.room_id AND c.users @> to_jsonb(ARRAY[m.user_id])) AS members' +
      ' ) member_ids' +
      ' LEFT JOIN LATERAL (' +
      ' SELECT e.seq, e.event_type, e.payload FROM room_event_outbox o JOIN room_events e USING (room_id, seq)' +
      ' WHERE o.room_id = c.room_id AND o.seq > c.seq AND cardinality(member_ids.members) > 0' +
      ' ORDER BY o.seq LIMIT 16' +
      ' ) e ON true ORDER BY c.room_id, e.seq',
      [JSON.stringify(cursors.map(({ roomId, seq, userIds }) => ({ room_id: roomId, seq, users: userIds })))],
    )
    const rooms = new Map<string, { roomId: string; roomExists: boolean; members: Set<number>; events: { seq: number; type: string; payload: unknown }[] }>()
    for (const row of rows) {
      let room = rooms.get(row.room_id)
      if (!room) {
        room = { roomId: row.room_id, roomExists: row.room_exists, members: new Set(row.members.map(Number)), events: [] }
        rooms.set(row.room_id, room)
      }
      if (row.seq !== null && row.event_type !== null) {
        room.events.push({ seq: Number(row.seq), type: row.event_type, payload: row.payload })
      }
    }
    return [...rooms.values()]
  } catch (error) {
    throw postgresError(error)
  }
}
