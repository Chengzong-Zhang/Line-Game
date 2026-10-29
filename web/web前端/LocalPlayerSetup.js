import { PLAYER_ORDER } from "./GameEngine.js?v=20261029-unified-r1";
import { PLAYER_PALETTE, playerLabel } from "./PlayerPalette.js?v=20261029-unified-r1";
import { LOCAL_LAB_MODELS, localPlayerChoices, usesGenericBoardAI, normalizeLocalPlayers } from "./LocalAIModes.js?v=20261029-unified-r1";
import { RESEARCH_FAMILIES } from "./ResearchAIOptions.js?v=20261029-unified-r1";
import { normalizeRoomPlayerSetup } from "./OnlineRoomSettings.js?v=20261029-unified-r1";

export default {
  name: "LocalPlayerSetup",
  emits: ["update-player", "select-lab-model", "update:start-player", "swap", "start", "open-topology-guide"],
  props: {
    texts: { type: Object, required: true },
    language: { type: String, default: "zh" },
    players: { type: Object, required: true },
    activePlayers: { type: Object, default: () => ({}) },
    playerCount: { type: Number, required: true },
    boardShape: { type: String, required: true },
    gridSize: { type: Number, default: 7 },
    startPlayer: { type: String, required: true },
    initialPositions: { type: Object, default: null },
    locked: { type: Boolean, default: false },
    pending: { type: Boolean, default: true },
    started: { type: Boolean, default: false },
    online: { type: Boolean, default: false },
  },
  setup(props, context) {
    const emit = context?.emit ?? (() => {});
    const ref = globalThis.Vue.ref ?? ((value) => ({ value }));
    const labColor = ref("WHITE");
    const labModelId = ref(LOCAL_LAB_MODELS[0].id);
    const chooseLabModel = () => {
      const model = LOCAL_LAB_MODELS.find((candidate) => candidate.id === labModelId.value);
      if (!model || props.locked || props.online || props.playerCount !== 2 || props.boardShape !== "triangle"
        || props.gridSize < 5 || props.gridSize > 15 || !["BLACK", "WHITE"].includes(labColor.value)) return;
      emit("select-lab-model", { color: labColor.value, patch: { choice: model.choice, version: model.version } });
    };
    return {
      genericAI: globalThis.Vue.computed(() => usesGenericBoardAI(props.playerCount, props.boardShape)),
      diamondBoard: globalThis.Vue.computed(() => props.boardShape === "diamond"),
      choices: globalThis.Vue.computed(() => localPlayerChoices(props.playerCount, props.boardShape)),
      choiceAvailable: (choice) => localPlayerChoices(props.playerCount, props.boardShape).includes(choice),
      labModels: LOCAL_LAB_MODELS,
      labColor,
      labModelId,
      selectedLabModel: globalThis.Vue.computed(() => LOCAL_LAB_MODELS.find((candidate) => candidate.id === labModelId.value)),
      labApplicable: globalThis.Vue.computed(() => !props.online && props.playerCount === 2
        && props.boardShape === "triangle" && props.gridSize >= 5 && props.gridSize <= 15),
      chooseLabModel,
      modelLabel: (player) => {
        const model = LOCAL_LAB_MODELS.find((candidate) => candidate.choice === player?.choice
          && (!RESEARCH_FAMILIES.includes(candidate.choice) || candidate.version === player?.version));
        if (model) return model.label;
        if (player?.choice === "minimax") return `Minimax · ${props.texts.aiDifficulty} ${player.depth}`;
        if (player?.choice === "three-player") return `${props.texts.localThreeAI}${player.version && player.version !== "legacy" ? ` · ${player.version}` : ""}`;
        if (player?.choice === "hex-player") return props.texts.localHexAI;
        return player?.choice ?? "—";
      },
      sides: globalThis.Vue.computed(() => {
        const players = props.online ? normalizeRoomPlayerSetup(props, props.players)
          : normalizeLocalPlayers(props.players, props.playerCount, props.boardShape);
        return PLAYER_ORDER.slice(0, props.playerCount).map(color => ({
          color, accent: PLAYER_PALETTE[color].accent, name: playerLabel(color, props.language), ...players[color],
        })).map((side, index) => ({
          ...side, vertex: props.playerCount === 2 ? [1, 4][index] : props.playerCount === 3 ? [1, 3, 5][index] : props.playerCount === 4 ? [1, 2, 4, 5][index] : index + 1,
          midpoint: index - 2,
        }));
      }),
      choiceLabel: (choice) => ({
        human: props.texts.localHuman, minimax: props.texts.localStandardAI, greedy: props.texts.localEasyAI,
        "topology-generic": props.texts.localTopologyGenericAI ?? props.texts.localGenericAI,
        "three-player": props.texts.localThreeAI,
        "hex-player": props.texts.localHexAI,
        "ai-easy": props.texts.localEasyAI, "ai-medium": props.texts.localMediumAI,
        "ai-hard": props.texts.localHardAI, "ai-ultimate": props.texts.localUltimateAI,
        "padded-cnn": "Padded-CNN + PUCT", "grid-gnn": "Grid-GNN + PUCT", "topology-gnn": "Topology-GNN + PUCT",
      }[choice] ?? choice.toUpperCase()),
      formatStartingPosition: (position) => {
        if (typeof position === "string") return position;
        if (Array.isArray(position) && position.every((item) => typeof item === "string")) return position.join(", ");
        if (Array.isArray(position) && position.length === 2 && position.every(Number.isInteger)) return `(${position[0] + 1}, ${position[1] + 1})`;
        return "";
      },
      difficultyLabel: (depth) => ({ 2: props.texts.aiDifficultyEasy, 3: props.texts.aiDifficultyMedium, 4: props.texts.aiDifficultyHard }[depth]),
    };
  },
  template: `
    <div class="local-match-setup">
      <div class="local-player-grid" :class="{ 'has-three-players': playerCount === 3, 'has-hex-players': playerCount >= 4 }">
        <section v-for="side in sides" :key="side.color" class="local-player-card" :class="'is-' + side.accent" :aria-labelledby="'local-player-heading-' + side.color">
          <div class="local-player-heading">
            <h3 :id="'local-player-heading-' + side.color">{{ side.name }}</h3>
            <span v-if="startPlayer === side.color || playerCount === 2" class="local-turn-badge">{{ startPlayer === side.color ? texts.localFirst : texts.localSecond }}</span>
          </div>
          <p v-if="initialPositions?.[side.color]" class="help-copy local-seat-label">{{ texts.startingPointLabel }} {{ formatStartingPosition(initialPositions[side.color]) }}</p>
          <p v-else-if="playerCount <= 6 && boardShape === 'hexagon'" class="help-copy local-seat-label">{{ texts.hexVertex(side.vertex) }}</p>
          <p v-else-if="playerCount <= 6 && side.midpoint > 0" class="help-copy local-seat-label">{{ texts.triangleMidpoint(side.midpoint) }}</p>
          <label class="field-label" :for="'local-player-' + side.color">{{ texts.localController }}</label>
          <select :id="'local-player-' + side.color" class="input-field local-player-select" :value="choiceAvailable(side.choice) ? side.choice : ''" :disabled="locked" :title="side.choice === 'human' ? texts.localHumanDescription : texts.aiModelDescriptions[side.choice]" @change="$emit('update-player', { color: side.color, patch: { choice: $event.target.value } })">
            <option v-if="!choiceAvailable(side.choice)" value="" disabled>{{ texts.localLabCurrentSelection }}</option>
            <option v-for="choice in choices" :key="choice" :value="choice">{{ choiceLabel(choice) }}</option>
          </select>
          <p v-if="started && !online && activePlayers?.[side.color] && !choiceAvailable(activePlayers[side.color].choice)" class="help-copy">{{ texts.localLabCurrent }}：{{ modelLabel(activePlayers[side.color]) }}</p>
          <p v-if="!choiceAvailable(side.choice) && (!started || side.choice !== activePlayers?.[side.color]?.choice || side.version !== activePlayers?.[side.color]?.version)" class="help-copy">{{ texts.localLabNext }}：{{ modelLabel(side) }}</p>
          <div v-if="side.choice === 'minimax'" class="local-player-difficulty">
            <label class="field-label" :id="'local-depth-label-' + side.color">{{ texts.aiDifficulty }}</label>
            <div class="board-choice-grid board-choice-grid-3col" role="group" :aria-labelledby="'local-depth-label-' + side.color">
              <button v-for="depth in [2, 3, 4]" :key="depth" type="button" class="board-choice-option board-choice-size" :class="{ 'is-active': side.depth === depth }" :aria-pressed="side.depth === depth" :disabled="locked" @click="$emit('update-player', { color: side.color, patch: { depth } })">{{ difficultyLabel(depth) }}</button>
            </div>
          </div>
        </section>
      </div>
      <details v-if="labApplicable" class="local-player-advanced local-ai-lab panel panel-subtle">
        <summary>{{ texts.localLabTitle }}</summary>
        <p class="help-copy">{{ labApplicable ? texts.localLabDescription : texts.localLabUnavailable }}</p>
        <div class="local-ai-lab-controls">
          <div>
            <label class="field-label" for="local-lab-seat">{{ texts.localLabSeat }}</label>
            <select id="local-lab-seat" class="input-field" v-model="labColor" :disabled="locked || !labApplicable">
              <option v-for="side in sides.slice(0, 2)" :key="side.color" :value="side.color">{{ side.name }}</option>
            </select>
          </div>
          <div>
            <label class="field-label" for="local-lab-model">{{ texts.localLabModel }}</label>
            <select id="local-lab-model" class="input-field" v-model="labModelId" :disabled="locked || !labApplicable">
              <option v-for="model in labModels" :key="model.id" :value="model.id">{{ model.label }}</option>
            </select>
          </div>
          <button type="button" class="action-button action-button-secondary" :disabled="locked || !labApplicable" @click="chooseLabModel">{{ texts.localLabApply }}</button>
        </div>
        <p v-if="selectedLabModel" class="help-copy">{{ texts.aiModelDescriptions[selectedLabModel.choice] }}</p>
        <p class="help-copy">{{ texts.localLabExperimental }}</p>
      </details>
      <div v-if="boardShape === 'custom'" class="topology-ai-scope">
        <p class="help-copy">{{ language === 'zh' ? '练习模式 · 棋力未评测' : 'Practice mode · Strength untested' }}</p>
        <button type="button" class="text-button" @click="$emit('open-topology-guide')">{{ language === 'zh' ? 'AI 榜与适用范围' : 'AI ladder and eligibility' }}</button>
      </div>
      <p v-if="genericAI && !online && boardShape !== 'custom'" class="help-copy">{{ playerCount >= 3
        ? diamondBoard ? texts.localDiamondMultiplayerAiNote : texts.localMultiplayerGenericNote
        : diamondBoard ? texts.localDiamondAiNote : texts.localGenericNote }}</p>
      <p v-else-if="!online && playerCount === 3" class="help-copy">{{ texts.localThreeHuman }}</p>
      <p v-else-if="!online && playerCount >= 4 && playerCount <= 6" class="help-copy">{{ texts.localHexHuman }}</p>
      <div class="local-match-toolbar">
        <div class="local-starter-field">
          <label for="local-start-player" class="field-label">{{ texts.starterLabel }}</label>
          <select id="local-start-player" class="input-field" :value="startPlayer" :disabled="locked" @change="$emit('update:start-player', $event.target.value)">
            <option v-for="side in sides" :key="side.color" :value="side.color">{{ side.name }}</option>
          </select>
        </div>
        <slot name="contribution" />
      </div>
      <button v-if="boardShape === 'custom'" type="button" class="action-button action-button-primary local-topology-start" :disabled="locked" @click="$emit('start')">{{ started ? texts.localStartNew : texts.localStart }}</button>
      <p v-if="online" class="help-copy">{{ language === 'zh' ? '创建人占用第一个真人席位，其他真人席位等待好友加入；其余席位按所选 AI 配置补位。' : 'The creator takes the first human seat. Friends join the other human seats; AI fills each configured AI seat.' }}</p>
      <p v-else class="help-copy" role="status">{{ pending ? texts.localPendingSettings : texts.localAppliedSettings }}</p>
    </div>
  `,
};
