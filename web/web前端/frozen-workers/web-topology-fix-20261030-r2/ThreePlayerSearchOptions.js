// Routing is explicit so a saved actor ID always names the policy that runs.
export const THREE_PLAYER_SEARCH_MODEL_ID = "three-player-search-v4-round12";
export const THREE_PLAYER_SEARCH_MODEL_SHA256 = "9b85f5fff27001d68407c30d6f707b461b1b468d657c8292339e97d23868c230";
export const THREE_PLAYER_SEARCH_SIZES = Object.freeze([5, 7, 9]);

export function threePlayerModelIdForBoard(gridSize) {
  return THREE_PLAYER_SEARCH_SIZES.includes(Number(gridSize))
    ? THREE_PLAYER_SEARCH_MODEL_ID : "three-player-policy-v1";
}
