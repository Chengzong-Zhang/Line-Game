// Player-facing onboarding for board-definition-v1 games.  This stays in the
// topology setup surface rather than the legacy coordinate tutorial: a seam
// can identify two chart copies of one canonical vertex, so it cannot be
// taught safely with the legacy rectangular board matrix.
export const TOPOLOGY_TUTORIAL_VERSION = "topology-onboarding-v1";

const freezeStep = (step) => Object.freeze({
  ...step,
  action: Object.freeze({ ...step.action }),
});

export const TOPOLOGY_TUTORIAL_STEPS = Object.freeze([
  freezeStep({
    id: "choose-a-board",
    action: { type: "select-preset", preset: "cylinder" },
    titleZh: "1. 先从一个预设开始",
    titleEn: "1. Start with a preset",
    instructionZh: "先选圆柱或莫比乌斯带，再开局。预设会把边界、接缝和起点一起固定；随机与手绘棋盘也会在开局前固定。",
    instructionEn: "Choose Cylinder or Möbius before starting. A preset freezes its boundaries, seams, and starts together; random and drawn boards are frozen before play too.",
  }),
  freezeStep({
    id: "read-seam-arrows",
    action: { type: "inspect-seam", field: "endpointMap" },
    titleZh: "2. 箭头说明穿缝方向",
    titleEn: "2. Arrows explain a seam crossing",
    instructionZh: "两条同编号的边由箭头配对。箭头同向或反向决定从哪一个端点进入另一侧；不要把屏幕两侧的距离当作棋盘距离。",
    instructionEn: "Two equally numbered edges are paired by arrows. Same or reversed arrows decide which endpoint enters the other side; screen distance is not board distance.",
  }),
  freezeStep({
    id: "recognize-copies",
    action: { type: "inspect-copy", field: "canonicalVertexId" },
    titleZh: "3. 边缘副本不是额外棋位",
    titleEn: "3. Edge copies are not extra moves",
    instructionZh: "展开图两边出现的同一个编号是同一规范点。点其中一个副本等于占据该棋位；计分和起点都只算一次。",
    instructionEn: "The same label on two chart edges is one canonical vertex. Playing either copy occupies that one point; scoring and starts count it once.",
  }),
  freezeStep({
    id: "read-real-boundary-and-score",
    action: { type: "inspect-score", strategy: "surface-discrete-v1" },
    titleZh: "4. 接缝不是盘外，围地按真实边界判断",
    titleEn: "4. A seam is not outside the board",
    instructionZh: "未粘合的边才是真实边界。正式分数是己方点和线，加上不含敌方且不接触真实边界的离散分量；闭曲面没有人为的“外面”。",
    instructionEn: "Only an unglued edge is a real boundary. Official score is your nodes and lines plus enemy-free components that do not touch a real boundary; a closed surface has no invented outside.",
  }),
  freezeStep({
    id: "mobius-flip",
    action: { type: "select-preset", preset: "mobius" },
    titleZh: "5. 莫比乌斯带会翻转方向",
    titleEn: "5. Möbius reverses orientation",
    instructionZh: "在莫比乌斯带上跨过接缝后，射线方向会按箭头和面侧运输而翻转。系统会沿实际路径连线，不会把一条线画成穿过整张屏幕的直弦。",
    instructionEn: "Crossing a Möbius seam transports and flips a ray using its arrows and face side. The game follows the actual path; it does not draw a straight chord across the screen.",
  }),
]);

export function topologyTutorialText(step, language = "zh") {
  if (!step || typeof step !== "object") return null;
  const english = language === "en";
  return {
    title: english ? step.titleEn : step.titleZh,
    instruction: english ? step.instructionEn : step.instructionZh,
  };
}

export function getTopologyTutorialStep(id) {
  return TOPOLOGY_TUTORIAL_STEPS.find((step) => step.id === id) ?? null;
}
