import assert from 'node:assert/strict'
import { test } from 'node:test'
import { occupancy, referenceScorecard } from './workload.mjs'

const OPEN = 1
const formats = ['txt', 'docx', 'pdf']

function referenceEvidence() {
  const clients = Array.from({ length: 5000 }, (_, index) => {
    const id = index + 1
    const multiGuest = id > 2500 && id <= 4500
    return {
      room: id <= 2500 ? id : multiGuest ? id - 2500 : null,
      gateway: multiGuest ? (id - 2500) % 6 : index % 6,
      socket: { readyState: OPEN, roomVerified: true, roomPhase: 'playing' },
    }
  })
  const initial = { ...occupancy(clients, 6, OPEN), matchesPlannedGateways: true }
  return {
    clients,
    formats,
    preparedByFormat: { txt: 40, docx: 40, pdf: 40 },
    actual: {
      metadataRows: 3_000_000, catalogOwners: 5000, largestLibrary: 250_000, warmupMs: 300_000,
      pacedMs: 1_800_000, pacedActions: 180_000, pacedImports: 60, burstImports: 20,
      burstActions: 500, reconnectClients: 1000,
    },
    initial,
    pacedStart: initial,
    samples: [initial],
    scope: { replicas: { gateways: 6, roomWorkers: 5, preparationWorkers: 2 } },
  }
}

test('the observed reference workload can pass while deployment acceptance remains unmeasured', () => {
  const evidence = referenceEvidence()
  const recovery = structuredClone(evidence.initial)
  recovery.openSockets = 4300
  recovery.playingRooms = 2300
  recovery.gateways[1].rooms = 1010
  evidence.samples.push(recovery)
  const { referenceWorkload, referenceAcceptance } = referenceScorecard(evidence)
  assert.deepEqual(evidence.initial.gateways.map((gateway) => gateway.rooms), [750, 751, 751, 750, 749, 749])
  assert.equal(referenceWorkload.roomSubscriptionCap.observedPeak, 1010)
  assert.equal(referenceWorkload.status, 'passed')
  assert.equal(referenceAcceptance.status, 'unmeasured')
})

test('open sockets without verified playing rooms cannot fill the reference workload', () => {
  const evidence = referenceEvidence()
  evidence.preparedByFormat = { txt: 80, docx: 39, pdf: 1 }
  evidence.actual.pacedMs = 60_000
  evidence.clients[0].socket.roomVerified = false
  evidence.clients[2501].gateway = 1
  evidence.clients[2000].socket.roomPhase = 'lobby'
  evidence.initial = { ...occupancy(evidence.clients, 6, OPEN), matchesPlannedGateways: false }
  const { referenceWorkload, referenceAcceptance } = referenceScorecard(evidence)
  assert.equal(referenceWorkload.initialOccupancy.openSockets.status, 'passed')
  assert.equal(referenceWorkload.initialOccupancy.playingRooms.observed, 2499)
  assert.equal(referenceWorkload.initialOccupancy.fullMultiplayerRooms.observed, 1999)
  assert.equal(referenceWorkload.initialOccupancy.crossGatewayMultiplayerRooms.observed, 1998)
  assert.equal(referenceWorkload.initialPlacement.status, 'missed')
  assert.equal(referenceWorkload.prepared.docx.status, 'missed')
  assert.equal(referenceWorkload.prepared.pdf.status, 'missed')
  assert.equal(referenceWorkload.counts.pacedMs.status, 'missed')
  assert.equal(referenceWorkload.status, 'missed')
  assert.equal(referenceAcceptance.status, 'unmeasured')
})

test('an aborted run cannot earn a reference workload pass', () => {
  const evidence = referenceEvidence()
  const { referenceWorkload } = referenceScorecard({ ...evidence, setupFailure: { stage: 'reconcile' } })
  assert.equal(referenceWorkload.status, 'unmeasured')
})
