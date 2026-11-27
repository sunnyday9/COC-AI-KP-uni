import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measureOffers, measureSubmissions, occupancy, referenceScorecard } from './workload.mjs'

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
      burstActions: 500, reconnectClients: 1000, pacedActionOffersPerSecond: 100, pacedImportOffersPerMinute: 2,
    },
    submissions: {
      pacedActions: { withinWindow: 180_000, attemptedPerSecond: 100 },
      pacedImports: { withinWindow: 60, attemptedPerSecond: 2 / 60 },
      burstActions: { withinWindow: 500 },
      burstImports: { withinWindow: 20 },
    },
    initial,
    pacedStart: initial,
    samples: [initial],
    scope: { pacedReadyReplicas: { gateways: 6, roomWorkers: 5, preparationWorkers: 2 } },
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
  assert.equal(referenceWorkload.sampledConfirmedSubscriptionCap.observedPeak, 1010)
  assert.equal(referenceWorkload.sustainedOccupancy.status, 'unmeasured')
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

test('longer low-rate traffic and late burst offers miss the reference offer rates and counts', () => {
  const evidence = referenceEvidence()
  const slowPacedActions = measureOffers(Array.from({ length: 180_000 }, (_, index) => index * 40), 0, 7_200_000)
  const slowPacedImports = measureOffers(Array.from({ length: 60 }, (_, index) => index * 120_000), 0, 7_200_000)
  const lateBurst = measureOffers([...Array.from({ length: 499 }, (_, index) => 20_000 + index * 2), 21_001], 20_000, 1000)
  Object.assign(evidence.actual, {
    pacedMs: 7_200_000,
    pacedActions: slowPacedActions.withinWindow,
    pacedImports: slowPacedImports.withinWindow,
    pacedActionOffersPerSecond: slowPacedActions.offeredPerSecond,
    pacedImportOffersPerMinute: slowPacedImports.offeredPerSecond * 60,
    burstActions: lateBurst.withinWindow,
  })
  const { referenceWorkload } = referenceScorecard(evidence)
  assert.equal(referenceWorkload.counts.pacedActions.status, 'passed')
  assert.equal(referenceWorkload.pacedRates.actionOffersPerSecond.observed, 25)
  assert.equal(referenceWorkload.pacedRates.actionOffersPerSecond.status, 'missed')
  assert.equal(referenceWorkload.pacedRates.importOffersPerMinute.status, 'missed')
  assert.equal(lateBurst.offerSpanMs, 1001)
  assert.equal(referenceWorkload.counts.burstActions.observed, 499)
  assert.equal(referenceWorkload.status, 'missed')
})

test('reference workload requires preparation readiness when paced traffic starts', () => {
  const evidence = referenceEvidence()
  evidence.scope.pacedReadyReplicas.preparationWorkers = 1
  const { referenceWorkload } = referenceScorecard(evidence)
  assert.equal(referenceWorkload.pacedReadyReplicas.preparationWorkers.status, 'missed')
  assert.equal(referenceWorkload.status, 'missed')
})

test('intent without dispatch cannot fill the reference burst and import workload', () => {
  const evidence = referenceEvidence()
  const start = 20_000
  const burstIntents = Array.from({ length: 500 }, (_, index) => start + index * 2)
  const burstDispatches = [...burstIntents.slice(0, 498), undefined, start + 1001]
  evidence.submissions.burstActions = measureSubmissions(burstDispatches, start, 1000)
  evidence.submissions.burstImports = measureSubmissions(Array(20).fill(undefined), start, 60_000)
  const { referenceWorkload } = referenceScorecard(evidence)
  assert.equal(measureOffers(burstIntents, start, 1000).withinWindow, 500)
  assert.equal(referenceWorkload.counts.burstActions.status, 'passed')
  assert.equal(referenceWorkload.submitted.burstActions.observed, 498)
  assert.equal(evidence.submissions.burstActions.attempted, 499)
  assert.equal(evidence.submissions.burstActions.attemptSpanMs, 1001)
  assert.equal(referenceWorkload.submitted.burstImports.observed, 0)
  assert.equal(referenceWorkload.status, 'missed')
})
