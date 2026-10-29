import { compileBoard } from "./BoardCompiler.js?v=20261029-unified-r1";

const SIZE = 32;
const ORIGIN = [36, 36];
export const EDITOR_GRID_SIZE = 9;
function effectiveGridSize(value) { return Number.isInteger(Number(value)) ? Math.max(5, Math.min(15, Number(value))) : EDITOR_GRID_SIZE; }
function pointScale(gridSize) { return Math.min(SIZE, 408 / (1.5 * (effectiveGridSize(gridSize) - 1)), 264 / (Math.sqrt(3) / 2 * (effectiveGridSize(gridSize) - 1))); }
export function latticePoint([x, y], gridSize = EDITOR_GRID_SIZE) {
  const scale = pointScale(gridSize);
  return [ORIGIN[0] + scale * (x + y / 2), ORIGIN[1] + scale * Math.sqrt(3) * y / 2];
}

// The SVG stretches to its CSS box, so touch and mouse use the same conversion.
export function editorPointFromClient(clientX, clientY, rect) {
  if (!rect.width || !rect.height) return null;
  return [(clientX - rect.left) * 480 / rect.width, (clientY - rect.top) * 300 / rect.height];
}
export function nearestEditorVertex(point, tolerance = 14, gridSize = EDITOR_GRID_SIZE) {
  if (!point) return null;
  let best = null, distance = tolerance;
  for (let y = 0; y < effectiveGridSize(gridSize); y++) for (let x = 0; x < effectiveGridSize(gridSize); x++) {
    const p = latticePoint([x, y], gridSize);
    const d = Math.hypot(point[0] - p[0], point[1] - p[1]);
    if (d <= distance) { best = [x, y]; distance = d; }
  }
  return best;
}
function segmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
export function nearestEditorEdge(point, edges, tolerance = 10, gridSize = EDITOR_GRID_SIZE) {
  if (!point) return null;
  let best = null, distance = tolerance;
  for (const edge of edges) {
    const d = segmentDistance(point, latticePoint(edge.coordinates[0], gridSize), latticePoint(edge.coordinates[1], gridSize));
    if (d < distance) { best = edge; distance = d; }
  }
  return best;
}

// Compile the unglued boundary so already paired edges still have an on-screen
// location; occurrence orientation is the compiler's face-side orientation.
export function editorBoundaryEdges(draft) {
  if (!draft?.closed || !draft.candidateDefinition) return [];
  const definition = { ...draft.candidateDefinition, seamPairs: [] };
  const compiled = compileBoard(definition);
  if (!compiled.ok) return [];
  const coordinates = new Map(definition.vertices.map(v => [v.id, v.coordinate]));
  return compiled.value.edgeClasses.filter(edge => edge.occurrences.length === 1).map(edge => {
    const occurrence = edge.occurrences[0];
    return { id: occurrence.id, coordinates: occurrence.vertices.map(id => coordinates.get(id)) };
  });
}

export function createSeamSelection() { return { stage: "first-edge", first: null, second: null, firstDirection: null }; }
export function chooseSeamEdge(state, edge, used) {
  if (!edge || used.has(edge.id)) return { ok: false, state, error: "used" };
  if (state.stage === "first-edge") return { ok: true, state: { ...state, stage: "first-direction", first: edge.id } };
  if (state.stage !== "second-edge" || edge.id === state.first) return { ok: false, state, error: "same" };
  return { ok: true, state: { ...state, stage: "second-direction", second: edge.id } };
}
export function chooseSeamDirection(state, direction) {
  if (![1, -1].includes(direction)) return { ok: false, state };
  if (state.stage === "first-direction") return { ok: true, state: { ...state, stage: "second-edge", firstDirection: direction } };
  if (state.stage === "second-direction") return { ok: true, state, pair: {
    edgeOccurrenceA: state.first, edgeOccurrenceB: state.second,
    endpointMap: state.firstDirection === direction ? [0, 1] : [1, 0],
  } };
  return { ok: false, state };
}

export const TopologyGraphicEditor = {
  props: { draft: { type: Object, required: true }, language: String, disabled: Boolean, message: String, gridSize: { type: Number, default: 9 } },
  emits: ["vertex", "close", "undo", "reset", "seam", "new-ring", "delete-ring"],
  setup(props, { emit }) {
    const { ref, computed, watch } = globalThis.Vue;
    const mode = ref("draw"), selection = ref(createSeamSelection()), notice = ref(""), activePointer = ref(null), pairDirections = ref({});
    const edges = computed(() => editorBoundaryEdges(props.draft));
    const used = computed(() => new Set((props.draft.seamPairs || []).flatMap(p => [p.edgeOccurrenceA, p.edgeOccurrenceB])));
    const zh = computed(() => props.language === "zh");
    const point = coordinate => latticePoint(coordinate, props.gridSize);
    const points = computed(() => {
      const result = [];
      for (let y = 0; y < effectiveGridSize(props.gridSize); y++) for (let x = 0; x < effectiveGridSize(props.gridSize); x++) result.push({ x, y, p: point([x, y]) });
      return result;
    });
    const gridLines = computed(() => {
      const result = [];
      for (const { x, y } of points.value) for (const [dx, dy] of [[1, 0], [0, 1], [1, -1]]) {
        if (x + dx < effectiveGridSize(props.gridSize) && y + dy >= 0 && y + dy < effectiveGridSize(props.gridSize)) result.push({ a: point([x, y]), b: point([x + dx, y + dy]), key: `${x},${y},${dx},${dy}` });
      }
      return result;
    });
    const byId = computed(() => new Map(edges.value.map(edge => [edge.id, edge])));
    const segments = computed(() => {
      if (!props.draft.closed) {
        const result = [];
        for (const [ringIndex, ring] of (props.draft.rings || []).entries()) for (let i = 0; i < ring.length; i++) result.push({ a: point(ring[i]), b: point(ring[(i + 1) % ring.length]), key: `ring:${ringIndex}:${i}` });
        for (let i = 1; i < (props.draft.path || []).length; i++) result.push({ a: point(props.draft.path[i - 1]), b: point(props.draft.path[i]), key: `path:${i}` });
        return result;
      }
      return edges.value.map(edge => {
        const pairIndex = (props.draft.seamPairs || []).findIndex(p => p.edgeOccurrenceA === edge.id || p.edgeOccurrenceB === edge.id);
        const pair = props.draft.seamPairs?.[pairIndex];
        const firstReverse = pair && pairDirections.value[pair.id] === -1;
        const reverse = pair && (edge.id === pair.edgeOccurrenceA ? firstReverse : Boolean(firstReverse) !== (pair.endpointMap[0] === 1));
        const selectedReverse = !pair && edge.id === selection.value.first && selection.value.firstDirection === -1;
        const coords = reverse || selectedReverse ? [...edge.coordinates].reverse() : edge.coordinates;
        return { a: point(coords[0]), b: point(coords[1]), key: edge.id, pair: pairIndex + 1,
          directionPreview: edge.id === currentEdgeId() || (edge.id === selection.value.first && selection.value.firstDirection != null),
          selected: edge.id === selection.value.first || edge.id === selection.value.second };
      });
    });
    function currentEdgeId() { return selection.value.stage === "first-direction" ? selection.value.first : selection.value.stage === "second-direction" ? selection.value.second : null; }
    const stageText = computed(() => {
      const texts = zh.value ? {
        "first-edge": "点击第一条尚未粘合的边。", "first-direction": "选择第一条边的箭头方向。",
        "second-edge": "点击第二条尚未粘合的边。", "second-direction": "选择第二条边的箭头方向。",
      } : { "first-edge": "Select the first unglued edge.", "first-direction": "Choose the first arrow direction.",
        "second-edge": "Select the second unglued edge.", "second-direction": "Choose the second arrow direction." };
      return texts[selection.value.stage];
    });
    const currentDirectionEdge = computed(() => byId.value.get(selection.value.stage === "first-direction" ? selection.value.first : selection.value.second));
    function pointer(event) {
      if (props.disabled) return;
      const point = editorPointFromClient(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
      if (mode.value === "draw" && !props.draft.closed) {
        const vertex = nearestEditorVertex(point, Math.min(14, pointScale(props.gridSize) * 0.43), props.gridSize);
        if (!vertex) return;
        const path = props.draft.path || [], last = path[path.length - 1];
        if (last && last[0] === vertex[0] && last[1] === vertex[1]) return;
        if (path.length >= 3 && path[0][0] === vertex[0] && path[0][1] === vertex[1]) emit("close");
        else emit("vertex", vertex);
      } else if (mode.value === "glue" && props.draft.closed && event.type === "pointerdown") {
        if (!["first-edge", "second-edge"].includes(selection.value.stage)) return;
        const result = chooseSeamEdge(selection.value, nearestEditorEdge(point, edges.value, Math.min(10, pointScale(props.gridSize) * 0.3), props.gridSize), used.value);
        if (!result.ok) notice.value = zh.value ? "请选择两条不同且尚未粘合的边。" : "Choose two different unglued edges.";
        else { selection.value = result.state; notice.value = ""; }
      }
    }
    function direction(value) {
      const result = chooseSeamDirection(selection.value, value);
      if (!result.ok) return;
      selection.value = result.state;
      if (result.pair) {
        const ids = new Set((props.draft.seamPairs ?? []).map(pair => pair.id));
        let number = 1;
        while (ids.has(`seam:${number}`)) number += 1;
        pairDirections.value = { ...pairDirections.value, [`seam:${number}`]: selection.value.firstDirection };
        emit("seam", result.pair);
      }
    }
    watch(() => props.draft.seamPairs?.length, (next, old) => { if (next > old) { selection.value = createSeamSelection(); notice.value = ""; } });
    watch(() => props.draft.closed, closed => { if (!closed) { mode.value = "draw"; selection.value = createSeamSelection(); } });
    watch(() => props.language, () => { notice.value = ""; });
    return { mode, selection, notice, activePointer, points, gridLines, segments, zh, stageText, currentDirectionEdge, latticePoint: point, pointer, direction,
      setMode(value) { mode.value = value; activePointer.value = null; selection.value = createSeamSelection(); notice.value = ""; },
      resetSelection() { selection.value = createSeamSelection(); notice.value = ""; },
      start(event) { if (activePointer.value !== null || props.disabled) return; activePointer.value = event.pointerId; event.currentTarget.setPointerCapture?.(event.pointerId); pointer(event); },
      move(event) { if (activePointer.value === event.pointerId && mode.value === "draw") pointer(event); },
      stop(event) { if (activePointer.value === event.pointerId) activePointer.value = null; },
    };
  },
  template: `
    <div class="topology-graphic-editor">
      <div class="actions">
        <button type="button" class="action-button action-button-secondary" :disabled="disabled" @click="setMode('draw'); if (draft.closed) $emit('new-ring')">{{ zh ? '画轮廓' : 'Draw contour' }}</button>
        <button type="button" class="action-button action-button-secondary" :disabled="disabled || !draft.closed" @click="setMode('glue')">{{ zh ? '粘边' : 'Glue edges' }}</button>
        <button type="button" class="action-button action-button-ghost" :disabled="disabled || (!draft.path.length && !draft.seamPairs.length)" @click="$emit('undo')">{{ zh ? '撤销' : 'Undo' }}</button>
        <button type="button" class="action-button action-button-ghost" :disabled="disabled || !draft.rings?.length" @click="$emit('delete-ring', draft.rings.length - 1)">{{ zh ? '删除最后轮廓' : 'Delete last contour' }}</button>
        <button type="button" class="action-button action-button-ghost" :disabled="disabled" @click="$emit('reset')">{{ zh ? '重置' : 'Reset' }}</button>
      </div>
      <div class="topology-editor-direction-bar" role="group" :aria-label="zh ? '箭头方向，以图上箭头为准' : 'Arrow direction, using the arrow shown'">
        <span>{{ zh ? '箭头方向：' : 'Arrow:' }}</span>
        <button type="button" class="action-button action-button-secondary" :disabled="disabled || mode !== 'glue' || !currentDirectionEdge" @click="direction(1)">{{ zh ? '保持方向' : 'Keep' }}</button>
        <button type="button" class="action-button action-button-secondary" :disabled="disabled || mode !== 'glue' || !currentDirectionEdge" @click="direction(-1)">{{ zh ? '反转方向' : 'Reverse' }}</button>
      </div>
      <svg class="topology-editor-canvas" viewBox="0 0 480 300" preserveAspectRatio="none" role="img" :aria-label="zh ? '三角点阵地图编辑器' : 'Triangular lattice map editor'" @pointerdown.prevent="start" @pointermove.prevent="move" @pointerup="stop" @pointercancel="stop" @lostpointercapture="stop">
        <defs><marker id="topology-editor-arrow" markerWidth="6" markerHeight="6" refX="4.5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="currentColor" /></marker></defs>
        <line v-for="line in gridLines" :key="line.key" :x1="line.a[0]" :y1="line.a[1]" :x2="line.b[0]" :y2="line.b[1]" class="topology-editor-grid" />
        <circle v-for="point in points" :key="point.x + ',' + point.y" :cx="point.p[0]" :cy="point.p[1]" r="2.2" class="topology-editor-dot" />
        <g v-for="segment in segments" :key="segment.key">
          <line :x1="segment.a[0]" :y1="segment.a[1]" :x2="segment.b[0]" :y2="segment.b[1]" :class="['topology-editor-edge', { glued: segment.pair, selected: segment.selected }]" :marker-end="segment.pair || segment.directionPreview ? 'url(#topology-editor-arrow)' : null" />
          <template v-if="segment.pair"><text :x="(segment.a[0]+segment.b[0])/2" :y="(segment.a[1]+segment.b[1])/2 - 5" class="topology-editor-label">{{ segment.pair }}</text></template>
        </g>
        <circle v-if="draft.path.length" :cx="latticePoint(draft.path[0])[0]" :cy="latticePoint(draft.path[0])[1]" r="5" class="topology-editor-start" />
      </svg>
      <p class="help-copy" role="status">{{ notice || (message?.startsWith('ERROR:') ? message.slice(6).trim() : '') || (draft.closed ? (mode === 'glue' ? stageText : (zh ? '轮廓已闭合；点击画轮廓可继续添加，也可粘边。填充采用奇偶规则。' : 'Contour closed. Select Draw contour to add another, or glue edges. Fill uses the even-odd rule.')) : (zh ? '沿相邻点画实线，点击起点闭合。' : 'Draw along adjacent dots; tap the starting point to close.')) }}</p>
      <p v-if="mode === 'glue'" class="help-copy">{{ zh ? '同号箭头表示两侧端点的对应方向，不是行棋方向。' : 'Matching numbered arrows show corresponding endpoints, not movement directions.' }}</p>
      <button v-if="mode === 'glue' && selection.stage !== 'first-edge'" type="button" class="text-button" @click="resetSelection">{{ zh ? '重新选择这对边' : 'Choose this pair again' }}</button>
    </div>
  `,
};
