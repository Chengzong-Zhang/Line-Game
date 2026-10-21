import { LOCAL_PLAYER_CHOICES, THREE_PLAYER_CHOICES, HEX_PLAYER_CHOICES, normalizeLocalPlayers } from "./LocalAIModes.js?v=20261021-three4";
import { RESEARCH_FAMILIES, TRANSFER_SEEDS } from "./ResearchAIOptions.js?v=20261020-three1";

export default {
  name: "LocalPlayerSetup",
  emits: ["update-player", "update:start-player", "swap", "start"],
  props: {
    texts: { type: Object, required: true },
    players: { type: Object, required: true },
    playerCount: { type: Number, required: true },
    startPlayer: { type: String, required: true },
    locked: { type: Boolean, default: false },
    pending: { type: Boolean, default: true },
    started: { type: Boolean, default: false },
  },
  setup(props) {
    return {
      choices: globalThis.Vue.computed(() => props.playerCount >= 4 ? HEX_PLAYER_CHOICES : props.playerCount === 3 ? THREE_PLAYER_CHOICES : LOCAL_PLAYER_CHOICES),
      families: RESEARCH_FAMILIES,
      versions: TRANSFER_SEEDS.map(String),
      sides: globalThis.Vue.computed(() => {
        const players = normalizeLocalPlayers(props.players, props.playerCount);
        return [
          { color: "BLACK", accent: "blue", name: props.texts.localBluePlayer, ...players.BLACK },
          { color: "WHITE", accent: "red", name: props.texts.localRedPlayer, ...players.WHITE },
          { color: "PURPLE", accent: "purple", name: props.texts.localPurplePlayer, ...players.PURPLE },
          { color: "GREEN", accent: "green", name: props.texts.localGreenPlayer, ...players.GREEN },
          { color: "ORANGE", accent: "orange", name: props.texts.localOrangePlayer, ...players.ORANGE },
          { color: "CYAN", accent: "cyan", name: props.texts.localCyanPlayer, ...players.CYAN },
        ].slice(0, props.playerCount).map((side, index) => ({
          ...side, vertex: props.playerCount === 4 ? [1, 2, 4, 5][index] : index + 1,
        }));
      }),
      choiceLabel: (choice) => ({
        human: props.texts.localHuman, minimax: "Minimax",
        "three-player": props.texts.localThreeAI,
        "hex-player": props.texts.localHexAI,
        "padded-cnn": "Padded-CNN + PUCT", "grid-gnn": "Grid-GNN + PUCT", "topology-gnn": "Topology-GNN + PUCT",
      }[choice] ?? choice.toUpperCase()),
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
          <p v-if="playerCount >= 4" class="help-copy local-seat-label">{{ texts.hexVertex(side.vertex) }}</p>
          <label class="field-label" :for="'local-player-' + side.color">{{ texts.localController }}</label>
          <select :id="'local-player-' + side.color" class="input-field local-player-select" :value="side.choice" :disabled="locked" @change="$emit('update-player', { color: side.color, patch: { choice: $event.target.value } })">
            <option v-for="choice in choices" :key="choice" :value="choice">{{ choiceLabel(choice) }}</option>
          </select>
          <p class="help-copy local-player-description">{{ side.choice === 'human' ? texts.localHumanDescription : texts.aiModelDescriptions[side.choice] }}</p>
          <div v-if="side.choice === 'minimax'" class="local-player-difficulty">
            <label class="field-label" :id="'local-depth-label-' + side.color">{{ texts.aiDifficulty }}</label>
            <div class="board-choice-grid board-choice-grid-3col" role="group" :aria-labelledby="'local-depth-label-' + side.color">
              <button v-for="depth in [2, 3, 4]" :key="depth" type="button" class="board-choice-option board-choice-size" :class="{ 'is-active': side.depth === depth }" :aria-pressed="side.depth === depth" :disabled="locked" @click="$emit('update-player', { color: side.color, patch: { depth } })">{{ difficultyLabel(depth) }}</button>
            </div>
          </div>
          <template v-if="families.includes(side.choice)">
            <p class="help-copy">{{ texts.localResearchNote }}</p>
            <details class="local-player-advanced">
              <summary>{{ texts.localAdvanced }}</summary>
              <label class="field-label" :for="'local-version-' + side.color">{{ texts.aiModelSeed }}</label>
              <select :id="'local-version-' + side.color" class="input-field" :value="side.version" :disabled="locked" @change="$emit('update-player', { color: side.color, patch: { version: $event.target.value } })">
                <option v-for="version in versions" :key="version" :value="version">{{ version }}</option>
                <option value="legacy">{{ texts.localLegacyModel }}</option>
              </select>
            </details>
          </template>
        </section>
      </div>
      <p v-if="playerCount === 3" class="help-copy">{{ texts.localThreeHuman }}</p>
      <p v-if="playerCount >= 4" class="help-copy">{{ texts.localHexHuman }}</p>
      <div class="local-match-toolbar">
        <div class="local-starter-field">
          <label for="local-start-player" class="field-label">{{ texts.starterLabel }}</label>
          <select id="local-start-player" class="input-field" :value="startPlayer" :disabled="locked" @change="$emit('update:start-player', $event.target.value)">
            <option v-for="side in sides" :key="side.color" :value="side.color">{{ side.name }}</option>
          </select>
        </div>
        <slot name="contribution" />
      </div>
      <p class="help-copy" role="status">{{ pending ? texts.localPendingSettings : texts.localAppliedSettings }}</p>
    </div>
  `,
};
