import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
} from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";
import GameController from "./GameController.js";
import { Player } from "./GameEngine.js";

function createDefaultGameState() {
  return {
    currentPlayer: Player.BLACK,
    gameOver: false,
    winner: null,
    turnCount: 0,
    consecutiveSkips: 0,
    scores: {
      [Player.BLACK]: 0,
      [Player.WHITE]: 0,
    },
    territories: {
      [Player.BLACK]: { area: 0, polygon: null },
      [Player.WHITE]: { area: 0, polygon: null },
    },
    legalMoves: [],
    snapshot: null,
  };
}

function formatArea(value) {
  return Number(value ?? 0).toFixed(1);
}

const ScorePanel = {
  name: "ScorePanel",
  props: {
    gameState: {
      type: Object,
      required: true,
    },
  },
  setup(props) {
    const currentPlayerLabel = computed(() => {
      return props.gameState.currentPlayer === Player.BLACK ? "蓝方回合" : "红方回合";
    });

    const winnerLabel = computed(() => {
      if (!props.gameState.gameOver) {
        return "对局进行中";
      }
      if (props.gameState.winner === Player.BLACK) {
        return "蓝方获胜";
      }
      if (props.gameState.winner === Player.WHITE) {
        return "红方获胜";
      }
      return "平局";
    });

    return {
      Player,
      currentPlayerLabel,
      winnerLabel,
      formatArea,
    };
  },
  template: `
    <section class="panel panel-score">
      <div class="panel-head">
        <p class="eyebrow">Match State</p>
        <h2>对局信息</h2>
      </div>

      <div class="turn-banner" :class="gameState.currentPlayer === Player.BLACK ? 'is-blue' : 'is-red'">
        <span class="turn-dot"></span>
        <strong>{{ currentPlayerLabel }}</strong>
        <small>{{ winnerLabel }}</small>
      </div>

      <div class="score-grid">
        <article class="score-card score-card-blue">
          <p>蓝方领土</p>
          <strong>{{ formatArea(gameState.scores[Player.BLACK]) }}</strong>
          <span>△ 面积</span>
        </article>
        <article class="score-card score-card-red">
          <p>红方领土</p>
          <strong>{{ formatArea(gameState.scores[Player.WHITE]) }}</strong>
          <span>△ 面积</span>
        </article>
      </div>

      <dl class="meta-list">
        <div>
          <dt>回合数</dt>
          <dd>{{ gameState.turnCount }}</dd>
        </div>
        <div>
          <dt>连续跳过</dt>
          <dd>{{ gameState.consecutiveSkips }}</dd>
        </div>
        <div>
          <dt>当前合法步</dt>
          <dd>{{ gameState.legalMoves.length }}</dd>
        </div>
      </dl>
    </section>
  `,
};

const ControlPanel = {
  name: "ControlPanel",
  emits: ["skip", "reset"],
  props: {
    disabled: {
      type: Boolean,
      default: false,
    },
  },
  template: `
    <section class="panel panel-controls">
      <div class="panel-head">
        <p class="eyebrow">Actions</p>
        <h2>操作</h2>
      </div>
      <div class="actions">
        <button class="action-button action-button-primary" :disabled="disabled" @click="$emit('skip')">
          跳过回合
        </button>
        <button class="action-button action-button-secondary" @click="$emit('reset')">
          重新开始
        </button>
      </div>
      <p class="help-copy">
        点击或触摸棋盘上的格点落子。领土填充和面积统计会跟随状态自动刷新。
      </p>
    </section>
  `,
};

const ResultModal = {
  name: "ResultModal",
  emits: ["reset"],
  props: {
    gameState: {
      type: Object,
      required: true,
    },
  },
  setup(props) {
    const title = computed(() => {
      if (!props.gameState.gameOver) {
        return "";
      }
      if (props.gameState.winner === Player.BLACK) {
        return "蓝方获胜";
      }
      if (props.gameState.winner === Player.WHITE) {
        return "红方获胜";
      }
      return "平局";
    });

    const summary = computed(() => {
      return `蓝方 ${formatArea(props.gameState.scores[Player.BLACK])} △  vs  红方 ${formatArea(props.gameState.scores[Player.WHITE])} △`;
    });

    return {
      title,
      summary,
    };
  },
  template: `
    <transition name="fade">
      <div v-if="gameState.gameOver" class="result-overlay" role="dialog" aria-modal="true">
        <div class="result-card">
          <p class="eyebrow">Game Over</p>
          <h2>{{ title }}</h2>
          <p class="result-summary">{{ summary }}</p>
          <button class="action-button action-button-primary" @click="$emit('reset')">
            开始新对局
          </button>
        </div>
      </div>
    </transition>
  `,
};

const BoardCanvas = {
  name: "BoardCanvas",
  emits: ["state-change", "controller-ready"],
  setup(_, { emit }) {
    const canvasRef = ref(null);
    let controller = null;

    const handleStateChange = (nextState) => {
      emit("state-change", nextState);
    };

    onMounted(() => {
      controller = new GameController(canvasRef.value, {
        onStateChange: handleStateChange,
      });
      emit("controller-ready", controller);
      controller.init();
    });

    onBeforeUnmount(() => {
      if (controller) {
        controller.destroy();
        controller = null;
      }
    });

    return {
      canvasRef,
    };
  },
  template: `
    <section class="board-shell panel">
      <div class="panel-head">
        <p class="eyebrow">Canvas Board</p>
        <h2>三角棋盘</h2>
      </div>
      <div class="canvas-frame">
        <canvas ref="canvasRef" class="game-canvas" aria-label="Triangular board"></canvas>
      </div>
    </section>
  `,
};

const App = {
  name: "TriangularGameApp",
  components: {
    BoardCanvas,
    ScorePanel,
    ControlPanel,
    ResultModal,
  },
  setup() {
    const controller = ref(null);
    const gameState = ref(createDefaultGameState());

    const statusText = computed(() => {
      if (gameState.value.gameOver) {
        if (gameState.value.winner === Player.BLACK) {
          return "蓝方控制了更大的领土。";
        }
        if (gameState.value.winner === Player.WHITE) {
          return "红方控制了更大的领土。";
        }
        return "双方领土相同，这一局打成平手。";
      }

      return gameState.value.currentPlayer === Player.BLACK
        ? "蓝方正在规划下一条扩张路径。"
        : "红方正在寻找突破口。";
    });

    const handleControllerReady = (instance) => {
      controller.value = instance;
      gameState.value = instance.getGameState();
    };

    const handleStateChange = (nextState) => {
      gameState.value = nextState;
    };

    const handleSkip = () => {
      if (!controller.value) {
        return;
      }
      const result = controller.value.skipTurn();
      gameState.value = result.state;
    };

    const handleReset = () => {
      if (!controller.value) {
        return;
      }
      gameState.value = controller.value.resetGame();
    };

    return {
      controller,
      gameState,
      statusText,
      handleControllerReady,
      handleStateChange,
      handleSkip,
      handleReset,
    };
  },
  template: `
    <main class="app-shell">
      <section class="hero">
        <div>
          <p class="eyebrow">Vue 3 + Canvas</p>
          <h1>TriAxis Web Arena</h1>
          <p class="hero-copy">
            Canvas 负责棋盘与领土绘制，Vue 负责回合、得分、操作面板和结束弹层。
          </p>
        </div>
        <div class="hero-status">
          <p class="status-label">战局播报</p>
          <p class="status-copy">{{ statusText }}</p>
        </div>
      </section>

      <section class="layout-grid">
        <BoardCanvas
          @controller-ready="handleControllerReady"
          @state-change="handleStateChange"
        />

        <aside class="sidebar">
          <ScorePanel :game-state="gameState" />
          <ControlPanel
            :disabled="!controller || gameState.gameOver"
            @skip="handleSkip"
            @reset="handleReset"
          />
        </aside>
      </section>

      <ResultModal :game-state="gameState" @reset="handleReset" />
    </main>
  `,
};

export default App;
