import { PDFDocument } from 'pdf-lib'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Zip = require('jszip')
const sharp = require('sharp')
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const officeRelationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships'

export const formats = ['txt', 'docx', 'pdf']
export const sheet = {
  playerName: 'Synthetic Archivist',
  occupationName: 'Archivist',
  derived: { hp: 10, hpMax: 10, mp: 5, mpMax: 5, san: 50, sanMax: 50 },
  attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 50 },
  skills: {},
}
const lines = [
  'The Old Library stands beside a quiet marsh.',
  'Inside the archive the investigators find a ledger.',
  'The ledger contains the names of missing sailors.',
  'The exit is marked on the map below the loose tile.',
]
const text = '旧图书馆内有一本破旧笔记。\n' + lines.join('\n')

export async function source(format, serial) {
  const paragraphs = Array.from({ length: 1 + serial % 6 }, (_, i) => text + '\nArchive reference ' + serial + ' section ' + (i + 1))
  if (format === 'txt') return Buffer.from(paragraphs.join('\n\n'))
  const image = await sharp(Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="512">' +
    '<rect width="1024" height="512" fill="white"/><text font-family="sans-serif" font-size="32">' +
    [...lines, 'Archive reference ' + serial].map((line, i) => '<tspan x="35" y="' + (62 + i * 58) + '">' + line + '</tspan>').join('') +
    '</text></svg>',
  )).png().toBuffer()
  if (format === 'pdf') {
    const pdf = await PDFDocument.create({ updateMetadata: false })
    const embedded = await pdf.embedJpg(await sharp(image).jpeg({ quality: 90 }).toBuffer())
    for (let i = 0; i < 1 + serial % 3; i++) {
      pdf.addPage([768, 384]).drawImage(embedded, { x: 0, y: 0, width: 768, height: 384 })
    }
    return Buffer.from(await pdf.save())
  }
  const zip = new Zip()
  const file = (path, data) => zip.file(path, data, { date: new Date('2000-01-01T00:00:00Z') })
  file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  file('_rels/.rels', '<Relationships xmlns="' + packageRelationships + '"><Relationship Id="main" Type="' + officeRelationships + '/officeDocument" Target="word/document.xml"/></Relationships>')
  file('word/_rels/document.xml.rels', '<Relationships xmlns="' + packageRelationships + '"><Relationship Id="map" Type="' + officeRelationships + '/image" Target="media/map.png"/></Relationships>')
  file('word/media/map.png', image)
  const content = paragraphs.flatMap((p) => p.split('\n')).map((line) => '<w:p><w:r><w:t>' + line + '</w:t></w:r></w:p>').join('')
  file('word/document.xml', '<w:document xmlns:w="' + wordNamespace + '" xmlns:r="' + officeRelationships + '" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<w:body>' + content + '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="map"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>')
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

export async function seedAccounts(pool, users, { metadataRows, largeLibrary }) {
  await pool.query(
    "INSERT INTO users (id, username, password_hash, created_at) SELECT i, 'fixture-' || i, 'fixture-only', 0 FROM generate_series(1, $1::integer) i",
    [users],
  )
  await pool.query(`
    INSERT INTO settings (user_id, data)
    SELECT i, jsonb_build_object('ai', jsonb_build_object('baseUrl',
      'http://127.0.0.1:' || (1 + (i - 1) % 8)))::text FROM generate_series(1, $1::integer) i
  `, [users])
  for (let begin = 1; begin <= metadataRows; begin += 50000) {
    await pool.query(`
      INSERT INTO story_catalog (owner_id, story_id, name, source_revision, source_size, extension, created_at)
      SELECT CASE WHEN i <= $2 THEN 1 ELSE 2 + ((i - $2 - 1) % ($3 - 1)) END,
             'metadata-' || i || '.txt', 'Synthetic metadata ' || i, md5('metadata:' || i)::uuid, 0, 'txt', i / 2
      FROM generate_series($4::integer, $1::integer) i
    `, [Math.min(begin + 49999, metadataRows), largeLibrary, users, begin])
  }
  await pool.query('ANALYZE story_catalog')
}

/** Seed the equivalent of saved, already-playing rooms using real prepared revisions. */
export async function seedRooms(pool, rooms, multiRooms, pins) {
  const opening = { id: 'fixture-opening', role: 'kp', content: 'The investigation begins.', timestamp: 0 }
  await pool.query(`
    INSERT INTO characters (id, user_id, name, sheet, updated_at)
    SELECT 'fixture-character-' || i, i, 'Synthetic Archivist', $2, 0 FROM generate_series(1, $1::integer) i
  `, [rooms + multiRooms, JSON.stringify(sheet)])
  const records = Array.from({ length: rooms }, (_, index) => {
    const owner_id = index + 1
    const pin = pins[Math.floor(index / 2) % pins.length]
    return {
      ...pin, owner_id, room_id: 'fixture-room-' + owner_id, invite_code: 'fixture-invite-' + owner_id,
      kind: index < multiRooms ? 'multi' : 'solo',
      state: JSON.stringify({
        seq: 300, phase: 'playing', turnWindowMs: 0, openingCheckpointed: true,
        workflow: index % 2 === 0 ? 'dossier' : 'rag', messages: [opening],
      }),
    }
  })
  await pool.query(`
    INSERT INTO rooms (room_id, owner_id, invite_code, story_id, story_owner_id, kind, phase, state, created_at, updated_at,
      story_preparation_revision, story_source_revision, event_seq)
    SELECT room_id, owner_id, invite_code, story_id, story_owner_id, kind, 'playing', state, 0, 0, revision, source_revision, 300
    FROM jsonb_to_recordset($1) AS fixture(room_id text, owner_id bigint, invite_code text, story_id text, story_owner_id bigint,
      kind text, state text, revision uuid, source_revision uuid)
  `, [JSON.stringify(records)])
  await pool.query(`
    INSERT INTO room_members (room_id, user_id, role, character_id, ready)
    SELECT room_id, owner_id, 'owner', 'fixture-character-' || owner_id, 1 FROM rooms
    UNION ALL
    SELECT room_id, owner_id + $1, 'member', 'fixture-character-' || (owner_id + $1), 1 FROM rooms WHERE kind = 'multi'
  `, [rooms])
}
