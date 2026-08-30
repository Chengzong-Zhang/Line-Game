export function coordinateControllerRoomSnapshot({
  controller,
  payload,
  incomingSettings,
  resetController = true,
  syncOnlineController,
  applySettingsToController,
}) {
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
