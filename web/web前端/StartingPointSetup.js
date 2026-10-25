import { getBoardPositions, PLAYER_ORDER, resolveInitialPositions } from "./GameEngine.js?v=20261025-ai1";
import { randomInitialPositions, STARTING_POINT_MODES } from "./StartingPoints.js?v=20261025-ai1";

const COLORS = ["#2473bd", "#cc4852", "#9654b5", "#368655", "#d87825", "#168d9c"];

export default {
  name: "StartingPointSetup",
  props: {
    playerCount: { type: Number, required: true },
    boardShape: { type: String, required: true },
    gridSize: { type: Number, required: true },
    selection: { type: Object, required: true },
    language: { type: String, default: "zh" },
    texts: { type: Object, required: true },
    locked: { type: Boolean, default: false },
    online: { type: Boolean, default: false },
  },
  emits: ["update", "start"],
  setup(props, { emit }) {
    const { ref, computed, watch } = globalThis.Vue;
    const activePlayer = ref("BLACK");
    const error = ref("");
    const column = ref(1);
    const row = ref(1);
    const mode = computed(() => props.selection.startingPointMode ?? "default");
    const copy = computed(() => props.language === "zh" ? {
      title: "选择起点", default: "默认起点", random: "随机起点", custom: "自定义起点",
      shuffle: "再随机一组", note: "每位玩家各有一个起点。与自己起点失去连线连接的棋子会被删除，其余规则不变。圆环标记起点。",
      pick: "先选玩家，再点下方棋盘设置起点。每个位置只能属于一位玩家。",
      preview: "起点预览", occupied: "这个位置已有其他玩家的起点，请选另一个位置。",
      invalid: "坐标不在棋盘上，请重新选择。", column: "列（从 1 开始）", row: "行（从 1 开始）",
      apply: "设置坐标", position: "位置", ready: "开局将使用上方起点；修改在点击“开始对局”后生效。",
      randomReady: "选定后开局使用上方起点。直接重开已开始的随机对局，会重新抽取起点。",
    } : {
      title: "Starting points", default: "Default", random: "Random", custom: "Custom",
      shuffle: "Shuffle again", note: "Each player has one starting point. Pieces disconnected from their own start are removed. All other rules stay the same. Rings mark the starts.",
      pick: "Select a player, then tap the preview to place their start. Each point can belong to only one player.",
      preview: "Starting point preview", occupied: "Another player already starts here. Choose a different point.",
      invalid: "This coordinate is outside the board.", column: "Column (from 1)", row: "Row (from 1)",
      apply: "Set coordinates", position: "Position", ready: "These starts will be used when you press Start match.",
      randomReady: "Start uses your selected preview. Restarting an existing random match draws new starting points.",
    });
    const positions = computed(() => {
      try { return resolveInitialPositions(props.gridSize, props.playerCount, props.selection.initialPositions, props.boardShape); }
      catch (_) { return resolveInitialPositions(props.gridSize, props.playerCount, null, props.boardShape); }
    });
    const sides = computed(() => PLAYER_ORDER.slice(0, props.playerCount).map((player, index) => ({
      player, color: COLORS[index], number: index + 1, point: positions.value[player],
      name: props.texts[["localBluePlayer", "localRedPlayer", "localPurplePlayer", "localGreenPlayer", "localOrangePlayer", "localCyanPlayer"][index]],
    })));
    const activeSide = computed(() => sides.value.find((side) => side.player === activePlayer.value) ?? sides.value[0]);
    const preview = computed(() => {
      const points = getBoardPositions(props.gridSize, props.playerCount, props.boardShape);
      const xs = points.map(([x, y]) => x + y / 2);
      const ys = points.map(([, y]) => y * Math.sqrt(3) / 2);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      const scale = 580 / Math.max(1, Math.max(...xs) - minX);
      const mapped = points.map((point, index) => ({ point, key: point.join(","),
        x: 30 + (xs[index] - minX) * scale, y: 30 + (ys[index] - minY) * scale,
        side: sides.value.find((side) => side.point.join(",") === point.join(",")),
      }));
      const byKey = new Map(mapped.map((point) => [point.key, point]));
      const lines = mapped.flatMap((from) => [[1, 0], [0, 1], [-1, 1]].flatMap(([dx, dy]) => {
        const to = byKey.get(`${from.point[0] + dx},${from.point[1] + dy}`);
        return to ? [{ from, to, key: `${from.key}|${to.key}` }] : [];
      }));
      return { points: mapped, lines, height: 60 + (Math.max(...ys) - minY) * scale,
        radius: Math.max(3, Math.min(9, scale * 0.22)), hitRadius: scale * 0.47,
        minWidth: Math.max(280, (Math.max(...xs) - minX) * 22 + 40) };
    });
    const syncCoordinates = () => {
      column.value = activeSide.value.point[0] + 1;
      row.value = activeSide.value.point[1] + 1;
    };
    watch(() => [props.playerCount, props.gridSize, props.boardShape, props.selection, activePlayer.value], () => {
      if (!PLAYER_ORDER.slice(0, props.playerCount).includes(activePlayer.value)) activePlayer.value = "BLACK";
      error.value = "";
      syncCoordinates();
    }, { immediate: true });
    const chooseMode = (value) => {
      if (props.locked) return;
      error.value = "";
      emit("update", value === "default" ? {} : {
        startingPointMode: value,
        initialPositions: value === "random" ? randomInitialPositions(props.gridSize, props.playerCount, Math.random, props.boardShape) : positions.value,
      });
    };
    const choosePoint = (point) => {
      if (props.locked || mode.value !== "custom") return;
      const player = activeSide.value.player;
      if (sides.value.some((side) => side.player !== player && side.point.join(",") === point.join(","))) {
        error.value = copy.value.occupied;
        return;
      }
      try {
        const next = resolveInitialPositions(props.gridSize, props.playerCount, { ...positions.value, [player]: point }, props.boardShape);
        error.value = "";
        emit("update", { startingPointMode: "custom", initialPositions: next });
      } catch (_) { error.value = copy.value.invalid; }
    };
    return { mode, modes: STARTING_POINT_MODES, copy, sides, activePlayer, activeSide, preview,
      column, row, error, chooseMode, choosePoint,
      applyCoordinates: () => choosePoint([Number(column.value) - 1, Number(row.value) - 1]),
    };
  },
  template: `
    <section class="starting-point-setup" aria-labelledby="starting-point-title">
      <h3 id="starting-point-title" class="field-label">{{ copy.title }}</h3>
      <div class="starting-point-modes" role="group" :aria-label="copy.title">
        <button v-for="item in modes" :key="item" type="button" class="board-choice-option"
          :class="{ 'is-active': mode === item }" :aria-pressed="mode === item" :disabled="locked"
          :data-start-mode="item" @click="chooseMode(item)">{{ copy[item] }}</button>
      </div>
      <p class="help-copy">{{ copy.note }}</p>
      <template v-if="preview">
        <button v-if="mode === 'random'" type="button" class="action-button action-button-secondary start-point-shuffle" :disabled="locked" @click="chooseMode('random')">{{ copy.shuffle }}</button>
        <p v-if="mode === 'custom'" class="help-copy">{{ copy.pick }}</p>
        <div class="starting-point-seats" role="group" :aria-label="copy.title">
          <button v-for="side in sides" :key="side.player" type="button" class="starting-point-seat"
            :class="{ 'is-active': mode === 'custom' && activeSide.player === side.player }"
            :style="{ '--start-color': side.color }" :data-start-player="side.player"
            :aria-pressed="mode === 'custom' && activeSide.player === side.player" :disabled="locked || mode !== 'custom'"
            @click="activePlayer = side.player">
            <span class="starting-point-number">{{ side.number }}</span><span>{{ side.name }}</span>
            <span class="starting-point-coordinate">({{ side.point[0] + 1 }}, {{ side.point[1] + 1 }})</span>
          </button>
        </div>
        <div class="starting-point-preview-scroll">
          <svg class="starting-point-preview" :style="{ minWidth: preview.minWidth + 'px' }"
            :viewBox="'0 0 640 ' + preview.height" role="group" :aria-label="copy.preview">
            <line v-for="line in preview.lines" :key="line.key" :x1="line.from.x" :y1="line.from.y" :x2="line.to.x" :y2="line.to.y" class="starting-point-grid-line" />
            <g v-for="point in preview.points" :key="point.key" :transform="'translate(' + point.x + ',' + point.y + ')'"
              :role="mode === 'custom' ? 'button' : 'img'" :tabindex="mode === 'custom' && !locked ? 0 : -1"
              :aria-label="copy.position + ' ' + (point.point[0] + 1) + ', ' + (point.point[1] + 1) + (point.side ? ' · ' + point.side.name : '')"
              :data-start-point="point.key" :class="{ 'is-editable': mode === 'custom' && !locked }"
              @click="choosePoint(point.point)" @keydown.enter.prevent="choosePoint(point.point)" @keydown.space.prevent="choosePoint(point.point)">
              <circle :r="preview.hitRadius" fill="transparent" />
              <circle :r="point.side ? preview.radius + 4 : preview.radius * 0.45" :fill="point.side ? point.side.color : '#b0a391'" />
              <circle v-if="point.side" :r="preview.radius + 8" fill="none" :stroke="point.side.color" stroke-width="2" />
              <text v-if="point.side" text-anchor="middle" dy=".35em" fill="white" :font-size="Math.max(8, preview.radius * 1.5)" font-weight="700">{{ point.side.number }}</text>
            </g>
          </svg>
        </div>
        <div v-if="mode === 'custom'" class="starting-point-coordinate-form">
          <label for="starting-column">{{ copy.column }}<input id="starting-column" class="input-field" type="number" min="1" :max="boardShape === 'hexagon' ? 2 * gridSize - 1 : gridSize" v-model="column" :disabled="locked" /></label>
          <label for="starting-row">{{ copy.row }}<input id="starting-row" class="input-field" type="number" min="1" :max="boardShape === 'hexagon' ? 2 * gridSize - 1 : gridSize" v-model="row" :disabled="locked" /></label>
          <button type="button" class="action-button action-button-secondary" :disabled="locked" @click="applyCoordinates">{{ copy.apply }}</button>
        </div>
        <p v-if="error" class="starting-point-error" role="alert">{{ error }}</p>
        <p class="help-copy" role="status">{{ online ? (language === 'zh' ? '房主修改后将同步给房间内所有玩家；开局和重连使用这组起点。' : 'The host shares these starts with everyone in the room. Matches and reconnections use the same points.') : (mode === 'random' ? copy.randomReady : copy.ready) }}</p>
      </template>
      <button v-if="!online" type="button" class="action-button action-button-primary starting-point-start" :disabled="locked" @click="$emit('start')">{{ texts.localStart }}</button>
    </section>
  `,
};
