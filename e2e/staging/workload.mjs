const referenceMinimums = {
  metadataRows: 3_000_000,
  catalogOwners: 5000,
  largestLibrary: 250_000,
  warmupMs: 300_000,
  pacedMs: 1_800_000,
  pacedActions: 180_000,
  pacedImports: 60,
  burstImports: 20,
  burstActions: 500,
  reconnectClients: 1000,
}

const referenceOccupancy = {
  openSockets: 5000,
  idleSockets: 500,
  playingRooms: 2500,
  fullMultiplayerRooms: 2000,
  crossGatewayMultiplayerRooms: 2000,
  roomSubscriptions: 4500,
}

export function occupancy(clients, gatewayCount, openState) {
  const byGateway = Array.from({ length: gatewayCount }, (_, gateway) => ({
    gateway, sockets: 0, rooms: new Set(),
  }))
  const playing = new Map()
  let openSockets = 0
  let idleSockets = 0
  for (const { room, socket, gateway } of clients) {
    if (socket?.readyState !== openState) continue
    openSockets++
    byGateway[gateway].sockets++
    if (!room) idleSockets++
    if (!room || !socket.roomVerified) continue
    byGateway[gateway].rooms.add(room)
    if (socket.roomPhase !== 'playing') continue
    if (!playing.has(room)) playing.set(room, [])
    playing.get(room).push(gateway)
  }
  const gateways = byGateway.map(({ gateway, sockets, rooms }) => ({ gateway, sockets, rooms: rooms.size }))
  const full = [...playing.values()].filter((placements) => placements.length === 2)
  return {
    openSockets,
    idleSockets,
    playingRooms: playing.size,
    fullMultiplayerRooms: full.length,
    crossGatewayMultiplayerRooms: full.filter(([first, second]) => first !== second).length,
    roomSubscriptions: gateways.reduce((sum, gateway) => sum + gateway.rooms, 0),
    gateways,
  }
}

export function referenceScorecard({ formats, preparedByFormat, actual, initial, pacedStart, samples, scope, setupFailure }) {
  const equals = (target, observed) => ({ target, observed: observed ?? null, status:
    observed == null ? 'unmeasured' : observed === target ? 'passed' : 'missed' })
  const atLeast = (target, observed) => ({ target, observed: observed ?? null, status:
    observed == null ? 'unmeasured' : observed >= target ? 'passed' : 'missed' })
  const topology = (snapshot) => Object.fromEntries(Object.entries(referenceOccupancy).map(([key, count]) =>
    [key, equals(count, snapshot?.[key])]))
  const counts = Object.fromEntries(Object.entries(referenceMinimums).map(([key, count]) =>
    [key, atLeast(count, actual[key])]))
  const prepared = Object.fromEntries(formats.map((format) => [format, atLeast(40, preparedByFormat?.[format])]))
  const initialOccupancy = topology(initial)
  const pacedStartOccupancy = topology(pacedStart)
  const initialPlacement = equals(true, initial?.matchesPlannedGateways)
  const startedReplicas = {
    gateways: equals(6, scope.replicas?.gateways),
    roomWorkers: equals(5, scope.replicas?.roomWorkers),
    preparationWorkers: equals(2, scope.replicas?.preparationWorkers),
  }
  const peakRoomSubscriptions = samples.length ? samples.reduce((peak, sample) =>
    Math.max(peak, ...sample.gateways.map((gateway) => gateway.rooms)), 0) : null
  const roomSubscriptionCap = {
    targetMaximum: 1024, observedPeak: peakRoomSubscriptions,
    status: peakRoomSubscriptions === null ? 'unmeasured' : peakRoomSubscriptions <= 1024 ? 'passed' : 'missed',
  }
  const checks = [
    ...Object.values(counts), ...Object.values(prepared), ...Object.values(initialOccupancy),
    ...Object.values(pacedStartOccupancy), ...Object.values(startedReplicas), initialPlacement, roomSubscriptionCap,
  ]
  const status = checks.some((check) => check.status === 'missed') ? 'missed'
    : setupFailure || checks.some((check) => check.status === 'unmeasured') ? 'unmeasured' : 'passed'
  return {
    referenceWorkload: { status, counts, prepared, initialOccupancy, pacedStartOccupancy, initialPlacement,
      startedReplicas, roomSubscriptionCap },
    referenceAcceptance: {
      status: 'unmeasured',
      reason: 'Generator, gateways and workers share one host and use loopback database and object storage endpoints. Distributed resource limits and live BYOK remain unmeasured.',
    },
  }
}
