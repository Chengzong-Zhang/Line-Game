// Synthetic completed games for a private collector probe, never production data.
import { createReplayDocument } from '../web前端/ReplayCodec.js';
import { createTopologySetup, useTopologyPreset } from '../../wechat/minigame/src/topology-setup.js';
import { topologySettingsFor, createTopologyReplayDocument } from '../../wechat/minigame/src/state.js';
import { contributionContext, CONTRIBUTION_V4_POLICY } from '../../wechat/minigame/src/training-contribution.js';
const order = ['PURPLE', 'BLACK', 'GREEN', 'WHITE'];
const base = { gridSize: 7, playerCount: 4, startPlayer: order[0], turnOrder: order,
  rulesVersion: 'territory-v3', boardShape: 'hexagon', hintEnabled: false, hintMaxCount: 3,
  turnTimerEnabled: false, turnTimeLimitSeconds: 60, undoEnabled: false, undoMaxCount: 3 };
const actions = order.map(player => ({type:'skip', player}));
const make = (settings, replay) => ({format:'lifeline-training-contribution', version:4, consent:true,
  consent_policy:CONTRIBUTION_V4_POLICY, replay,
  context:contributionContext({settings, controllerFor:()=> 'human', undoUsage:{usedCount:0}},4)});
const preset = useTopologyPreset(createTopologySetup(), 'cylinder', {gridSize:7, playerCount:4}).setup;
const topology = topologySettingsFor(preset.definition, {...base, boardHash:preset.boardHash});
const payloads = { ordered_grid: make(base, await createReplayDocument(base, actions)),
  ordered_topology: make(topology, createTopologyReplayDocument(topology, actions)) };
process.stdout.write(JSON.stringify(payloads));
