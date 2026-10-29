import { compileBoard } from "./BoardCompiler.js?v=20261029-unified-r1";
import { createProductSurfacePreset as createSurfacePreset } from "./ProductSurfacePresets.js?v=20261030-topology-fix";

const PLAYERS = ["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"];
const COLORS = ["#3378dc", "#e84c54", "#a263d2", "#36a968", "#ef9b35", "#2cb8c0"];

// Restore a preset's original roots after a persisted custom layout. Validate
// the entire geometry, so a hand-edited board with stale preset metadata is
// never silently replaced by a factory preset.
export function topologyDefaultDefinition(definition, gridSize) {
  const name = definition?.topology?.preset;
  if (name) {
    try {
      const preset = createSurfacePreset(name, { gridSize });
      const expected = compileBoard(preset);
      const sameGeometry = compileBoard({ ...definition, startingVertices: preset.startingVertices });
      if (expected.ok && sameGeometry.ok && expected.value.boardHash === sameGeometry.value.boardHash) return preset;
    } catch (_) { /* Unknown or edited preset: derive deterministic graph defaults. */ }
  }
  return { ...definition, startingVertices: {} };
}

export function topologyStartGeometry(compiled, playerCount) {
  if (!compiled) return { copies: [], edges: [] };
  const owners = new Map();
  for (const [index, player] of PLAYERS.slice(0, playerCount).entries()) {
    const roots = compiled.startingRoots?.[player] ?? [compiled.startingVertices?.[player]].filter(Boolean);
    for (const root of roots) owners.set(root, index);
  }
  const project = ([x, y]) => [x + y / 2, Math.sqrt(3) * y / 2];
  const rawCopies = compiled.atlas.pointCopies;
  const projected = rawCopies.map((p) => project(p.coordinate));
  const minX = Math.min(...projected.map(p => p[0])), maxX = Math.max(...projected.map(p => p[0]));
  const minY = Math.min(...projected.map(p => p[1])), maxY = Math.max(...projected.map(p => p[1]));
  const scale = Math.min(360 / Math.max(1, maxX - minX), 240 / Math.max(1, maxY - minY));
  const offsetX = (400 - scale * (maxX - minX)) / 2, offsetY = (280 - scale * (maxY - minY)) / 2;
  const position = coordinate => { const p = project(coordinate); return [offsetX + (p[0] - minX) * scale, offsetY + (p[1] - minY) * scale]; };
  const copies = rawCopies.map((p) => { const [x, y] = position(p.coordinate); return { ...p, x, y, owner: owners.get(p.canonicalVertexId) }; });
  const coordinates = new Map(compiled.definition.vertices.map(v => [v.id, v.coordinate]));
  const seams = new Map();
  for (const [index, pair] of (compiled.definition.seamPairs ?? []).entries()) {
    seams.set(pair.edgeOccurrenceA, { index, reverse: false });
    seams.set(pair.edgeOccurrenceB, { index, reverse: pair.endpointMap[0] === 1 });
  }
  const seen = new Set(), edges = [];
  for (const edge of compiled.edgeClasses) for (const occurrence of edge.occurrences) {
    const key = [...occurrence.vertices].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const seam = seams.get(occurrence.id);
    const vertices = seam?.reverse ? [...occurrence.vertices].reverse() : occurrence.vertices;
    const a = position(coordinates.get(vertices[0])), b = position(coordinates.get(vertices[1]));
    edges.push({ key, a, b, boundary: edge.occurrences.length === 1, seam: seam?.index });
  }
  return { copies, edges };
}

export function topologyStartCopies(compiled, playerCount) {
  return topologyStartGeometry(compiled, playerCount).copies;
}

export default {
  name: "TopologyStartingPointSetup",
  props: {
    definition: { type: Object, required: true },
    playerCount: { type: Number, required: true },
    language: { type: String, default: "zh" },
    locked: { type: Boolean, default: false },
  },
  emits: ["change"],
  setup(props, { emit }) {
    const { computed, ref } = globalThis.Vue;
    const active = ref(null);
    const compiled = computed(() => { const result = compileBoard(props.definition); return result.ok ? result.value : null; });
    const players = computed(() => PLAYERS.slice(0, props.playerCount));
    const geometry = computed(() => topologyStartGeometry(compiled.value, props.playerCount));
    const copies = computed(() => geometry.value.copies);
    const roots = () => Object.fromEntries(players.value.map((player) => [player,
      [...(compiled.value?.startingRoots?.[player] ?? [compiled.value?.startingVertices?.[player]].filter(Boolean))]]));
    const currentCounts = computed(() => players.value.map((player) => ({ player, count: roots()[player].length })));
    globalThis.Vue.watch(players, (next) => { if (active.value && !next.includes(active.value)) active.value = null; });
    function toggle(vertex) {
      if (props.locked || !compiled.value || !players.value.includes(active.value)) return;
      const next = roots();
      if (players.value.some((p) => p !== active.value && next[p].includes(vertex))) return;
      const own = next[active.value];
      const index = own.indexOf(vertex);
      if (index >= 0) { if (own.length === 1) return; own.splice(index, 1); }
      else { if (own.length >= 6) return; own.push(vertex); }
      emit("change", { mode: "custom", roots: next });
    }
    return { active, compiled, players, currentCounts, copies, geometry, toggle, COLORS,
      colorFor: (player) => COLORS[PLAYERS.indexOf(player)],
      labelFor: (player) => ({ BLACK: props.language === 'zh' ? '蓝方' : 'Blue', WHITE: props.language === 'zh' ? '红方' : 'Red', PURPLE: props.language === 'zh' ? '紫方' : 'Purple', GREEN: props.language === 'zh' ? '绿方' : 'Green', ORANGE: props.language === 'zh' ? '橙方' : 'Orange', CYAN: props.language === 'zh' ? '青方' : 'Cyan' }[player]),
    };
  },
  template: `
    <section class="topology-start-setup" v-if="compiled">
      <h3>{{ language === 'zh' ? '设置起点' : 'Starting points' }}</h3>
      <div class="actions">
        <button type="button" class="action-button action-button-secondary" :disabled="locked" @click="$emit('change', { mode: 'random', countPerPlayer: 1 })">{{ language === 'zh' ? '随机起点' : 'Random starts' }}</button>
      </div>
      <p class="help-copy">{{ language === 'zh' ? '当前起点：' : 'Current starts: ' }}<span v-for="(item, index) in currentCounts" :key="item.player">{{ index ? ' · ' : '' }}{{ labelFor(item.player) }} {{ item.count }}</span></p>
      <div class="actions" role="group" :aria-label="language === 'zh' ? '选择玩家' : 'Select player'">
        <button v-for="player in players" :key="player" type="button" class="language-button" :class="{ 'is-active': active === player }" :disabled="locked" :aria-pressed="active === player" @click="active = player"><span :style="{ color: colorFor(player) }">●</span> {{ labelFor(player) }}</button>
      </div>
      <button type="button" class="action-button action-button-secondary" :disabled="locked || !active" :title="!active ? (language === 'zh' ? '先选择玩家' : 'Select a player first') : ''" @click="$emit('change', { mode: 'append-random', player: active })">{{ language === 'zh' ? '添加随机起点' : 'Add random start' }}</button>
      <svg viewBox="0 0 400 280" class="topology-start-map" role="group" :aria-label="language === 'zh' ? '选择玩家后点击棋位添加或移除起点，每方一至六个；接缝副本代表同一棋位' : 'Select a player, then click points to add or remove one to six starts; seam copies represent the same point'">
        <defs><marker id="topology-start-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="#374151" /></marker></defs>
        <line v-for="edge in geometry.edges" :key="edge.key" :x1="edge.a[0]" :y1="edge.a[1]" :x2="edge.b[0]" :y2="edge.b[1]" :stroke="edge.seam === undefined ? (edge.boundary ? '#64748b' : '#cbd5e1') : COLORS[edge.seam % COLORS.length]" :stroke-width="edge.seam === undefined ? (edge.boundary ? 2 : 1) : 2.5" :stroke-dasharray="edge.seam === undefined ? null : '4 2'" :marker-end="edge.seam === undefined ? null : 'url(#topology-start-arrow)'" />
        <g v-for="point in copies" :key="point.sourceVertexId" @click="toggle(point.canonicalVertexId)" @keydown.enter.prevent="toggle(point.canonicalVertexId)" @keydown.space.prevent="toggle(point.canonicalVertexId)" tabindex="0" role="button" :aria-label="point.canonicalVertexId">
          <circle :cx="point.x" :cy="point.y" r="8" :fill="point.owner === undefined ? '#e5e7eb' : COLORS[point.owner]" stroke="#475569" />
        </g>
      </svg>
    </section>`
};
