import { createReplayDocument } from "./ReplayCodec.js?v=20261025-room1";

export const CONTRIBUTION_POLICY = "anonymous-replay-training-v1";
export const CONTRIBUTION_STORAGE = "lifeline-training-contribution-v1";
const MAX_QUEUE = 5;
const MAX_BYTES = 500000;

// The reviewed inbox still uses the legacy actor schema. Keep new multiplayer
// profiles local until the server and review pipeline explicitly support them.
export function supportsContributionActors(actors) {
  return !Object.values(actors ?? {}).some((actor) => actor?.strategy === "multiplayer");
}

// No account, room, chat, device fingerprint or network address enters this queue.
export class TrainingContribution {
  constructor({ storage, fetcher = globalThis.fetch?.bind(globalThis), onChange = () => {} } = {}) {
    if (storage === undefined) { try { storage = globalThis.localStorage; } catch (_) { /* Unavailable in private/restricted browser contexts. */ } }
    this.storage = storage; this.fetcher = fetcher; this.onChange = onChange;
    this.enabled = true; this.queue = []; this.lastReceipt = null; this.status = "ready";
    this.active = false; this.generation = 0; this.controller = null;
    try {
      const saved = JSON.parse(storage?.getItem(CONTRIBUTION_STORAGE) ?? "null");
      if (saved?.policy === CONTRIBUTION_POLICY && typeof saved.enabled === "boolean") {
        this.enabled = saved.enabled;
        this.queue = this.enabled && Array.isArray(saved.queue) ? saved.queue.slice(0, MAX_QUEUE) : [];
        this.lastReceipt = saved.lastReceipt ?? null;
        this.status = this.enabled ? (this.queue.length ? "pending" : "ready") : "off";
      }
    } catch (_) { /* The live game does not depend on contribution storage. */ }
  }
  snapshot() { return { enabled: this.enabled, pending: this.queue.length, status: this.status, receipt: this.lastReceipt }; }
  save() {
    try {
      this.storage?.setItem(CONTRIBUTION_STORAGE, JSON.stringify({ policy: CONTRIBUTION_POLICY, enabled: this.enabled, queue: this.queue, lastReceipt: this.lastReceipt }));
    } catch (_) { this.status = "storage-error"; }
    this.onChange(this.snapshot());
  }
  setEnabled(enabled) {
    this.enabled = enabled === true; this.generation++;
    if (!this.enabled) { this.queue = []; this.controller?.abort(); }
    this.status = this.enabled ? "ready" : "off"; this.save();
  }
  async enqueue(settings, actions, context) {
    if (!this.enabled) return false;
    // The reviewed inbox has no territory-v3 schema. Keep new-rule games local.
    if (settings?.rulesVersion === "territory-v3") return false;
    // The current reviewed-data pipeline encodes triangular boards only.
    // Hexagonal games remain exportable replays without entering that inbox.
    if (Number(settings?.playerCount) >= 4 || settings?.boardShape === "hexagon" || settings?.initialPositions) return false;
    if (!supportsContributionActors(context?.actors)) return false;
    const generation = this.generation;
    const replay = await createReplayDocument(settings, structuredClone(actions));
    if (!this.enabled || generation !== this.generation || !replay.terminal) return false;
    const payload = { format: "lifeline-training-contribution", version: 1, consent: true, consent_policy: CONTRIBUTION_POLICY, replay, context: structuredClone(context) };
    const id = replay.integrity.canonicalDocumentHash;
    if (this.lastReceipt?.documentHash === id || this.queue.some((item) => item.id === id)) return false;
    if (new TextEncoder().encode(JSON.stringify(payload)).length > MAX_BYTES) { this.status = "too-large"; this.save(); return false; }
    if (this.queue.length >= MAX_QUEUE) { this.status = "queue-full"; this.save(); return false; }
    this.queue.push({ id, payload }); this.status = "pending"; this.save();
    return true;
  }
  async flush() {
    if (!this.enabled || this.active || !this.queue.length) return;
    this.active = true; const generation = this.generation;
    try {
      while (this.enabled && generation === this.generation && this.queue.length) {
        const item = this.queue[0]; this.controller = new AbortController();
        const timer = setTimeout(() => this.controller?.abort(), 15000);
        let response;
        try {
          response = await this.fetcher("/api/training/contributions", { method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.payload), signal: this.controller.signal });
        } finally { clearTimeout(timer); }
        if (!this.enabled || generation !== this.generation) break;
        if (!response.ok) { this.status = response.status === 503 ? "unavailable" : "retry"; break; }
        const receipt = await response.json();
        if (!/^[a-f0-9]{64}$/.test(receipt.game_id ?? "") || !["awaiting_review", "duplicate"].includes(receipt.status)) throw new Error("Invalid receipt");
        if (!this.enabled || generation !== this.generation) break;
        this.lastReceipt = { gameId: receipt.game_id, documentHash: item.id };
        this.queue.shift(); this.status = "received"; this.save();
      }
    } catch (_) { if (this.enabled && generation === this.generation) this.status = "retry"; }
    finally { this.active = false; this.controller = null; this.save(); }
  }
  dispose() { this.generation++; this.controller?.abort(); }
}

export const ContributionPanel = {
  props: { language: String, state: Object, supported: { type: Boolean, default: true } }, emits: ["toggle", "retry"],
  computed: {
    copy() {
      return this.language === "zh" ? {
        title: "帮 AI 学下棋", opt: "自愿贡献匿名棋谱", retry: "重试上传", unsupported: "当前AI组合暂不支持贡献，可导出棋谱保存在本机。",
        off: "未开启，不上传", ready: "已开启，完整对局结束后自动提交", pending: "已保存在本机，等待上传", received: "服务器已收到，等待筛选", unavailable: "采集服务尚未启用，记录留在本机", retryStatus: "上传失败，记录留在本机", storage: "本机存储不可用，待上传记录可能无法恢复", full: "待上传队列已满，请先重试", large: "棋谱超过上传大小限制",
      } : {
        title: "Help the AI learn", opt: "Contribute anonymous replays", retry: "Retry upload", unsupported: "Contributions are not available for these AI players. You can export a replay to keep it locally.",
        off: "Off: no uploads", ready: "On: submit after a local match ends", pending: "Saved on this device, awaiting upload", received: "Received by the server; awaiting selection", unavailable: "Collection is not enabled on the server; saved locally", retryStatus: "Upload failed; saved locally", storage: "Local storage unavailable; pending uploads may not survive refresh", full: "Upload queue full; retry first", large: "Replay exceeds the upload size limit",
      };
    },
    statusLabel() { return this.copy[({ retry: "retryStatus", "storage-error": "storage", "queue-full": "full", "too-large": "large" })[this.state.status] ?? this.state.status]; },
  },
  template: `<div class="training-contribution training-contribution-inline">
    <p class="field-label">{{ copy.title }}</p>
    <button type="button" role="switch" class="board-choice-option training-contribution-toggle" :class="{ 'is-active': supported && state.enabled }" :aria-checked="supported && state.enabled" :disabled="!supported" @click="$emit('toggle', !state.enabled)"><span aria-hidden="true">{{ supported && state.enabled ? '✓' : '○' }}</span>{{ copy.opt }}</button>
    <p v-if="!supported" class="help-copy">{{ copy.unsupported }}</p>
    <button v-if="state.enabled && state.pending && ['retry', 'unavailable', 'storage-error', 'queue-full'].includes(state.status)" type="button" class="contribution-retry" :title="statusLabel" @click="$emit('retry')">{{ copy.retry }} ({{ state.pending }})</button>
  </div>`,
};
