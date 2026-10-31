import { PLAYER_ORDER } from './GameEngine.js?v=20261029-unified-r1';
import { formatPlayerName } from './OnlineAppI18n.js?v=20261029-unified-r1';

// Missing legacy order follows the engine's canonical cyclic seat order.
export function resizeTurnOrder(order, count, starter) {
  const seats = PLAYER_ORDER.slice(0, count);
  if (seats.length !== count || count < 2 || !seats.includes(starter)) throw new Error('INVALID_TURN_ORDER');
  if (order != null && (!Array.isArray(order) || new Set(order).size !== order.length || order.some(p => !PLAYER_ORDER.includes(p)))) throw new Error('INVALID_TURN_ORDER');
  const remaining = (order ?? seats).filter(p => seats.includes(p));
  for (const seat of seats) if (!remaining.includes(seat)) remaining.push(seat);
  const index = remaining.indexOf(starter);
  return [...remaining.slice(index), ...remaining.slice(0, index)];
}
export function moveTurnOrder(order, from, to) {
  if (!Array.isArray(order) || new Set(order).size !== order.length || !Number.isInteger(from) || !Number.isInteger(to)
    || from < 0 || to < 0 || from >= order.length || to >= order.length) throw new Error('INVALID_TURN_ORDER');
  const result = [...order]; const [item] = result.splice(from, 1); result.splice(to, 0, item); return result;
}
const COLORS = ['#2476ac','#c45548','#8a56a1','#3a885e','#ce7a32','#24919a','#c25f8d','#805d48','#729532','#354d8a','#a67a16','#238378','#a34a91','#6b7583','#cc745a'];
export default {
  name: 'TurnOrderSetup',
  props: { order: { type:Array, required:true }, language: { type:String, required:true }, uiStyle: { type:String, required:true }, locked: Boolean },
  emits: ['change'],
  data() { return { dragging: null }; },
  methods: {
    playerName(player) { return formatPlayerName(player, this.language, this.uiStyle); },
    color(player) { return COLORS[PLAYER_ORDER.indexOf(player)] ?? '#555'; },
    move(from,to) { if (!this.locked && to >= 0 && to < this.order.length && from !== to) this.$emit('change', moveTurnOrder(this.order,from,to)); },
    drop(index) { if (this.dragging !== null) this.move(this.dragging,index); this.dragging = null; },
  },
  template: `<section class="turn-order-setup" :aria-label="language === 'zh' ? '行动顺序' : 'Turn order'">
    <strong class="field-label">{{ language === 'zh' ? '行动顺序' : 'Turn order' }}</strong>
    <p class="help-copy">{{ language === 'zh' ? '拖动排序，或使用上下按钮；第一位先手。' : 'Drag to reorder, or use the move buttons. The first player starts.' }}</p>
    <ol class="turn-order-list">
      <li v-for="(player,index) in order" :key="player" class="turn-order-item" :draggable="!locked" @dragstart="dragging = index" @dragend="dragging = null" @dragover.prevent @drop.prevent="drop(index)">
        <span class="turn-order-name"><span class="turn-order-number">{{ index + 1 }}</span><span class="turn-order-stone" :style="{ backgroundColor: color(player) }" aria-hidden="true"></span>{{ playerName(player) }}</span>
        <span class="turn-order-actions"><button type="button" :disabled="locked || index === 0" :aria-label="(language === 'zh' ? '上移 ' : 'Move up ') + playerName(player)" @click="move(index,index-1)">↑</button><button type="button" :disabled="locked || index === order.length-1" :aria-label="(language === 'zh' ? '下移 ' : 'Move down ') + playerName(player)" @click="move(index,index+1)">↓</button></span>
      </li>
    </ol>
  </section>`
};
