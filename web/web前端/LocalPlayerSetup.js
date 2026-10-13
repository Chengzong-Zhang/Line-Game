import { LOCAL_PLAYER_CHOICES, normalizeLocalPlayers } from "./LocalAIModes.js?v=20261013-sync1";
import { RESEARCH_FAMILIES, TRANSFER_SEEDS } from "./ResearchAIOptions.js?v=20261013-sync1";

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
      choices: LOCAL_PLAYER_CHOICES,
      families: RESEARCH_FAMILIES,
      versions: TRANSFER_SEEDS.map(String),
      sides: globalThis.Vue.computed(() => {
        const players = normalizeLocalPlayers(props.players);
        return [
          { color: "BLACK", accent: "blue", name: props.texts.localBluePlayer, ...players.BLACK },
          { color: "WHITE", accent: "red", name: props.texts.localRedPlayer, ...players.WHITE },
        ];
      }),
      choiceLabel: (choice) => ({
        human: props.texts.localHuman, minimax: "Minimax",
        "padded-cnn": "Padded-CNN + PUCT", "grid-gnn": "Grid-GNN + PUCT", "topology-gnn": "Topology-GNN + PUCT",
      }[choice] ?? choice.toUpperCase()),
      difficultyLabel: (depth) => ({ 2: props.texts.aiDifficultyEasy, 3: props.texts.aiDifficultyMedium, 4: props.texts.aiDifficultyHard }[depth]),
    };
  },
  template: `
    <div class="local-match-setup">
      <div v-if="playerCount === 2" class="local-player-grid">
        <section v-for="side in sides" :key="side.color" class="local-player-card" :class="'is-' + side.accent" :aria-labelledby="'local-player-heading-' + side.color">
          <div class="local-player-heading">
            <h3 :id="'local-player-heading-' + side.color">{{ side.name }}</h3>
            <span class="local-turn-badge">{{ startPlayer === side.color ? texts.localFirst : texts.localSecond }}</span>
          </div>
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
      <p v-else class="help-copy">{{ texts.localThreeHuman }}</p>
      <div class="local-match-toolbar">
        <div class="local-starter-field">
          <label for="local-start-player" class="field-label">{{ texts.starterLabel }}</label>
          <select id="local-start-player" class="input-field" :value="startPlayer" :disabled="locked" @change="$emit('update:start-player', $event.target.value)">
            <option value="BLACK">{{ texts.localBlue }}</option>
            <option value="WHITE">{{ texts.localRed }}</option>
            <option v-if="playerCount === 3" value="PURPLE">{{ texts.localPurple }}</option>
          </select>
        </div>
        <slot name="contribution" />
      </div>
      <p class="help-copy" role="status">{{ pending ? texts.localPendingSettings : texts.localAppliedSettings }}</p>
    </div>
  `,
};
