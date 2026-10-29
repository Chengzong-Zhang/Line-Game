const TOPOLOGY_ROOM_CAPABILITY = "board-topology-v1";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function topologyRequested(settings) {
  return isObject(settings) && (
    settings.rulesVersion === "surface-v1"
    || settings.boardShape === "custom"
    || Object.hasOwn(settings, "boardDefinition")
    || Object.hasOwn(settings, "boardHash")
  );
}

function fail(code, detail) {
  return { ok: false, isTopology: true, code, detail };
}

function sameTopologyDefinition(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateTopologySettings(settings, label) {
  if (!isObject(settings)) return fail("INVALID_TOPOLOGY_SETTINGS", label + " must be an object.");
  if (settings.rulesVersion !== "surface-v1") {
    return fail("UNSUPPORTED_TOPOLOGY_RULES_VERSION", label + " must use surface-v1.");
  }
  if (settings.boardShape !== "custom") {
    return fail("INVALID_TOPOLOGY_BOARD_SHAPE", label + " must use custom boardShape.");
  }
  if (settings.topologyProtocolVersion !== TOPOLOGY_ROOM_CAPABILITY) {
    return fail("UNSUPPORTED_TOPOLOGY_PROTOCOL", label + " has an unsupported topology protocol.");
  }
  if (!isObject(settings.boardDefinition)) {
    return fail("MISSING_BOARD_DEFINITION", label + " must include a complete boardDefinition.");
  }
  if (typeof settings.boardHash !== "string" || !settings.boardHash) {
    return fail("MISSING_BOARD_HASH", label + " must include a non-empty boardHash.");
  }
  return { ok: true, isTopology: true, settings };
}

/**
 * Validate the topology-specific authority boundary before it reaches a
 * controller.  It intentionally does not repair partial settings: rejection
 * retains the active board rather than downgrading it to a legacy triangle.
 */
export function validateTopologyRoomSnapshot(
  payload,
  incomingSettings = payload?.settings,
  topologyCapabilities = [TOPOLOGY_ROOM_CAPABILITY],
) {
  const payloadSettings = payload?.settings;
  const requested = topologyRequested(incomingSettings) || topologyRequested(payloadSettings);
  if (!requested) return { ok: true, isTopology: false };

  const capabilities = Array.isArray(topologyCapabilities) ? topologyCapabilities : [];
  if (!capabilities.includes(TOPOLOGY_ROOM_CAPABILITY)) {
    return fail("TOPOLOGY_CAPABILITY_REQUIRED", "This client does not support board-topology-v1.");
  }

  const incoming = validateTopologySettings(incomingSettings, "incoming settings");
  if (!incoming.ok) return incoming;
  const room = validateTopologySettings(payloadSettings, "room settings");
  if (!room.ok) return room;
  if (incoming.settings.boardHash !== room.settings.boardHash
    || !sameTopologyDefinition(incoming.settings.boardDefinition, room.settings.boardDefinition)) {
    return fail("TOPOLOGY_SETTINGS_MISMATCH", "Incoming settings do not match the room board.");
  }

  const matchState = payload?.matchState;
  if (!matchState) return { ok: true, isTopology: true };
  const match = validateTopologySettings(matchState.settings, "match settings");
  if (!match.ok) return match;
  if (match.settings.boardHash !== room.settings.boardHash
    || !sameTopologyDefinition(match.settings.boardDefinition, room.settings.boardDefinition)) {
    return fail("TOPOLOGY_MATCH_SETTINGS_MISMATCH", "Reconnect settings do not match the room board.");
  }
  if (!Array.isArray(matchState.actions)) {
    return fail("INVALID_TOPOLOGY_ACTIONS", "Topology match actions must be an array.");
  }
  for (const action of matchState.actions) {
    if (!isObject(action) || action.type !== "player_move") continue;
    if (typeof action.vertexId !== "string" || !action.vertexId) {
      return fail("TOPOLOGY_VERTEX_ID_REQUIRED", "Topology move actions require vertexId.");
    }
    if (typeof action.boardHash !== "string" || action.boardHash !== room.settings.boardHash) {
      return fail("BOARD_HASH_MISMATCH", "Topology move action boardHash does not match the room.");
    }
    if (Object.hasOwn(action, "point")) {
      return fail("TOPOLOGY_COORDINATE_MOVE_REJECTED", "Topology move actions cannot use legacy point coordinates.");
    }
  }
  return { ok: true, isTopology: true };
}

export function coordinateControllerRoomSnapshot({
  controller,
  payload,
  incomingSettings,
  resetController = true,
  syncOnlineController,
  applySettingsToController,
  topologyCapabilities = [TOPOLOGY_ROOM_CAPABILITY],
}) {
  const topologyValidation = validateTopologyRoomSnapshot(
    payload,
    incomingSettings,
    topologyCapabilities,
  );
  if (!topologyValidation.ok) {
    controller?.setAuthoritativeSnapshotValid?.(false);
    controller?.setMultiplayerState?.({
      roomReady: false,
      opponentConnected: false,
    }, false);
    return {
      success: false,
      reason: topologyValidation.code,
      state: null,
      hasMatchState: Boolean(payload?.matchState && controller),
      authoritativeSnapshotAccepted: false,
    };
  }
  const hasMatchState = Boolean(payload?.matchState && controller);
  syncOnlineController(payload, false);

  if (!hasMatchState) {
    const authoritativeSnapshotAccepted = Boolean(controller && resetController);
    if (authoritativeSnapshotAccepted) {
      controller.setAuthoritativeSnapshotValid?.(true);
    }
    applySettingsToController(incomingSettings, resetController, true);
    if (!resetController) {
      syncOnlineController(payload, true);
    }
    return {
      success: true,
      reason: null,
      state: null,
      hasMatchState: false,
      authoritativeSnapshotAccepted,
    };
  }

  const restoreResult = controller.restoreMatchState({
    ...payload.matchState,
    settings: incomingSettings,
  });
  if (!restoreResult.success) {
    // Keep the authoritative room/session metadata, but fail closed around the
    // preserved board even when a custom controller implementation does not
    // lock itself after rejecting the snapshot.
    controller.setAuthoritativeSnapshotValid?.(false);
    controller.setMultiplayerState?.({
      roomReady: false,
      opponentConnected: false,
    }, false);
    return {
      ...restoreResult,
      hasMatchState: true,
      authoritativeSnapshotAccepted: false,
    };
  }

  controller.setAuthoritativeSnapshotValid?.(true);
  applySettingsToController(incomingSettings, false, false);
  return {
    ...restoreResult,
    hasMatchState: true,
    authoritativeSnapshotAccepted: true,
  };
}

export function registerRoomSnapshotResponseListeners({
  networkManager,
  roomCreatedEvent,
  roomJoinedEvent,
  applyRoomSnapshot,
  onApplied,
}) {
  const applyResponse = (payload) => applyRoomSnapshotWithPostCommit({
    payload,
    resetController: true,
    applyRoomSnapshot,
    onApplied,
  });

  return [
    networkManager.on(roomCreatedEvent, applyResponse),
    networkManager.on(roomJoinedEvent, applyResponse),
  ];
}

export function applyRoomSnapshotWithPostCommit({
  payload,
  resetController = true,
  applyRoomSnapshot,
  onApplied,
}) {
  if (!applyRoomSnapshot(payload, resetController)) {
    return false;
  }
  onApplied?.(payload);
  return true;
}
