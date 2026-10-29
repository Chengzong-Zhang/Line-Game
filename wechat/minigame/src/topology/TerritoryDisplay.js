import { GameEngine, PLAYER_ORDER } from "./GameEngine.js?v=20261029-topology-round5";
import { expandPathEdgeOccurrences } from "./BoardPathProjection.js?v=20261029-topology-round5";

// Display-only adaptation of the legacy right-hand contour, shortest-path
// tightening and flood validation. The official topology area is never read or
// changed here. Work separately in each atlas chart; never join distant seam
// copies with a chord. Ambiguous local adjacencies are left unpainted.
const cache = new WeakMap();
const keyOf = ([x, y]) => `${x},${y}`;
const edgeKey = (a, b) => [a, b].sort().join("\0");
const neighbors = [[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];

// Canvas fills all of one player's pieces in a single nonzero-winding path.
// A full triangle and an overlapping clipped contour can arrive with opposite
// winding and cancel, producing a hole that the 3D owner sampler cannot see.
function orientPieces(regions) {
  for (const region of regions) {
    const p = region.polygon;
    const twiceArea = p.reduce((sum, q, i) => sum + q[0]*p[(i+1)%p.length][1] - q[1]*p[(i+1)%p.length][0], 0);
    if (twiceArea < 0) region.polygon = [...p].reverse();
  }
  return regions;
}

// The public game constructor deliberately limits playable board sizes to 15.
// Display geometry needs a larger triangular workspace to surround a 15×15
// atlas chart. It is an isolated engine, never a game or scoring authority.
function makeDisplayWorkspace(size) {
  const engine = new GameEngine({ gridSize: Math.min(size, 15) });
  if (size > 15) {
    engine.gridSize = size;
    engine.validPositions = [];
    engine.positionKeys = new Set();
    engine.grid = new Map();
    engine._initGrid();
  }
  return engine;
}

// Clip a contour to one genuine atlas face. This prevents any part of a
// local contour from connecting across a seam or leaking into another chart.
function clipToFace(polygon, triangle) {
  const cross = (a, b, p) => (b[0]-a[0])*(p[1]-a[1]) - (b[1]-a[1])*(p[0]-a[0]);
  const orientation = Math.sign(cross(triangle[0], triangle[1], triangle[2]));
  if (!orientation) return [];
  let output = polygon.slice();
  for (let i = 0; i < 3 && output.length; i++) {
    const a = triangle[i], b = triangle[(i+1)%3], input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j+1)%input.length];
      const cp = orientation * cross(a,b,p), cq = orientation * cross(a,b,q);
      if (cp >= -1e-9) output.push(p);
      if ((cp < -1e-9 && cq > 1e-9) || (cp > 1e-9 && cq < -1e-9)) {
        const t = cp / (cp - cq);
        output.push([p[0] + t*(q[0]-p[0]), p[1] + t*(q[1]-p[1])]);
      }
    }
  }
  return output;
}

// Face-dual enclosure complements the chart contour where a genuine closed
// wall surrounds only narrow faces and no interior canonical vertex exists.
// A seam pairs edge occurrences, never merely equal endpoint IDs. On a closed
// surface no outside is distinguished, so only a strict minority of all
// faces smaller than the largest component is selected. Ties and an uncut
// whole surface stay unpainted.
function enclosedFaceRegions(snapshot, view, player, { countedOnly = false } = {}) {
  const faces = view.faces ?? [], copies = new Map((view.pointCopies ?? []).map(c=>[c.id,c]));
  const playerIndex = PLAYER_ORDER.indexOf(player);
  if (playerIndex < 0 || !faces.length) return [];
  const played = new Set(expandPathEdgeOccurrences(view, (snapshot.topologyPaths?.[player] ?? []).flatMap(path=>path.edgeOccurrences ?? [])));
  if (!played.size) return [];
  const occurrences = new Map(), groups = new Map();
  for (const face of faces) for (let i=0;i<(face.copyIds?.length ?? 0);i++) {
    const id = `${face.id}:${i}`, a=face.copyIds[i], b=face.copyIds[(i+1)%face.copyIds.length];
    const key=edgeKey(a,b), item={id,face,key};
    occurrences.set(id,item);
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(item);
  }
  const seamMate = new Map();
  for (const pair of view.seamPairs ?? []) {
    seamMate.set(pair.edgeOccurrenceA,pair.edgeOccurrenceB);
    seamMate.set(pair.edgeOccurrenceB,pair.edgeOccurrenceA);
  }
  const adjacency=new Map(faces.map(face=>[face.id,[]]));
  const boundary=new Set(), wallFaces=new Set();
  const visitedEdges=new Set();
  for (const item of occurrences.values()) {
    let group=groups.get(item.key) ?? [];
    const seam=seamMate.get(item.id);
    if (seam && occurrences.has(seam)) group=[item,occurrences.get(seam)];
    const edgeId=group.map(x=>x.id).sort().join("\0");
    if (visitedEdges.has(edgeId)) continue;
    visitedEdges.add(edgeId);
    const wall=group.some(x=>played.has(x.id));
    if (wall) for (const x of group) wallFaces.add(x.face.id);
    // An exposed edge is an escape only when it is not part of this player's
    // wall. A played edge along a real boundary closes the face component;
    // treating it as open loses enclosed triangles attached to that boundary.
    if (group.length === 1) { if (!wall) boundary.add(item.face.id); continue; }
    if (!wall) for (const x of group) for (const y of group) if (x.face.id !== y.face.id) adjacency.get(x.face.id).push(y.face.id);
  }
  const faceById=new Map(faces.map(face=>[face.id,face]));
  const noRealBoundary=(view.realBoundarySegments ?? []).length === 0;
  const counted = new Set((snapshot.territories?.[player]?.components ?? [])
    .filter(component => component.counted).flatMap(component => component.sampleIds ?? []));
  const seen=new Set(), regions=[], components=[];
  for (const root of faces) {
    if (seen.has(root.id)) continue;
    const queue=[root.id], component=[]; seen.add(root.id);
    let touchesBoundary=false, touchesWall=false, containsEnemy=false, containsCounted=false;
    while (queue.length) {
      const id=queue.pop(), face=faceById.get(id); component.push(face);
      touchesBoundary ||= boundary.has(id); touchesWall ||= wallFaces.has(id);
      containsEnemy ||= (face.copyIds ?? []).some(copyId=> {
        const state=snapshot.boardStates[copies.get(copyId)?.canonicalVertexId];
        return Number.isInteger(state) && state > 0 && state !== 1+2*playerIndex && state !== 2+2*playerIndex;
      });
      containsCounted ||= (face.copyIds ?? []).some(copyId=>counted.has(copies.get(copyId)?.canonicalVertexId));
      for (const next of adjacency.get(id) ?? []) if (!seen.has(next)) {seen.add(next);queue.push(next);}
    }
    components.push({component,touchesBoundary,touchesWall,containsEnemy,containsCounted});
  }
  // Several noncontractible cuts can produce three or more components all
  // smaller than half the surface. Never color all of them: components tied
  // for largest supply no uniquely preferred outside and remain unpainted.
  const maxSize=Math.max(...components.map(c=>c.component.length));
  for (const {component,touchesBoundary,touchesWall,containsEnemy,containsCounted} of components) {
    if (touchesBoundary || !touchesWall || containsEnemy
      || (countedOnly && !containsCounted)
      || (!countedOnly && noRealBoundary && !containsCounted && (component.length*2 >= faces.length || component.length === maxSize))) continue;
    for (const face of component) {
      const vertices=(face.copyIds ?? []).map(id=>copies.get(id));
      if (vertices.length === 3 && vertices.every(Boolean)) regions.push({player, faceId:face.id, chartId:vertices[0].chartId ?? "chart:0", kind:"face", polygon:vertices.map(c=>[...c.coordinate])});
    }
  }
  return regions;
}

export function buildTopologyTerritoryDisplay(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const signature = JSON.stringify([snapshot.boardStates, snapshot.territoryPending, snapshot.territories, snapshot.topologyPaths]);
  if (cache.get(snapshot)?.signature === signature) return cache.get(snapshot).polygons;
  const view = snapshot.topology?.viewBoard;
  const copies = view?.pointCopies ?? [];
  if (!copies.length || !snapshot.boardStates) return [];
  const edges = new Set();
  for (const face of view.faces ?? []) {
    for (let i = 0; i < (face.copyIds?.length ?? 0); i++) {
      edges.add(edgeKey(face.copyIds[i], face.copyIds[(i + 1) % face.copyIds.length]));
    }
  }
  // For a quotient surface there is no globally distinguished outside. A
  // canonical flood component identifies the counted side without inventing
  // one; represent it with actual triangular faces, not vertex-sized tiles.
  // Owned-only faces require all three genuine played edge occurrences.
  if (snapshot.boardDefinition?.seamPairs?.length) {
    const byId = new Map(copies.map(copy => [copy.id, copy]));
    const displayEdges = new Map((view.displayEdges ?? []).map(edge => [edge.id, edge]));
    const regions = [];
    for (const [player, territory] of Object.entries(snapshot.territories ?? {})) {
      const scored = new Set(territory?.renderPoints ?? []);
      const enclosed = new Set((territory?.components ?? []).filter(component => component.counted)
        .flatMap(component => component.sampleIds ?? []));
      // A counted canonical point does not imply every face whose vertices are
      // counted is on the counted side of the wall. Alias copies and boundary
      // vertices occur on both sides. Resolve the side using actual face-edge
      // adjacency first, then admit only faces in that counted component.
      const countedFaces = new Set(enclosedFaceRegions(snapshot, view, player, {countedOnly:true}).map(part=>part.faceId));
      const countedFaceCopies = new Set((view.faces ?? []).filter(face=>countedFaces.has(face.id)).flatMap(face=>face.copyIds ?? []));
      const playedEdges = new Set();
      const adjacency = new Map();
      for (const path of snapshot.topologyPaths?.[player] ?? []) {
        for (const occurrence of expandPathEdgeOccurrences(view, path.edgeOccurrences ?? [])) {
          const edge = displayEdges.get("guide:" + occurrence) ?? displayEdges.get(occurrence);
          const ids = edge?.copyIds ?? [edge?.fromCopyId, edge?.toCopyId];
          if (ids.length === 2 && ids.every(id => byId.has(id))) {
            playedEdges.add(edgeKey(...ids));
            for (const [a,b] of [ids, [...ids].reverse()]) {
              if (!adjacency.has(a)) adjacency.set(a, new Set());
              adjacency.get(a).add(b);
            }
          }
        }
      }
      const filledFaces = new Set();
      for (const face of view.faces ?? []) {
        const faceCopies = (face.copyIds ?? []).map(id => byId.get(id));
        if (faceCopies.length !== 3 || faceCopies.some(copy => !copy || !scored.has(copy.canonicalVertexId))) continue;
        const hasInterior = faceCopies.some(copy => enclosed.has(copy.canonicalVertexId));
        const closedPlayedFace = face.copyIds.every((id, index) => playedEdges.has(edgeKey(id, face.copyIds[(index + 1) % 3])));
        if (!(hasInterior && (!countedFaces.size || countedFaces.has(face.id))) && !closedPlayedFace) continue;
        regions.push({ player, faceId: face.id, chartId: faceCopies[0].chartId ?? "chart:0", kind: "face", polygon: faceCopies.map(copy => [...copy.coordinate]) });
        filledFaces.add(face.id);
      }
      // Follow only physically traversed local occurrences. Connected pieces
      // on opposite sides of a seam stay separate, even when their canonical
      // endpoint IDs are identical. Each piece reuses the ordinary contour.
      const unseen = new Set(adjacency.keys());
      const playerIndex = PLAYER_ORDER.indexOf(player);
      while (unseen.size && playerIndex >= 0) {
        const first = unseen.values().next().value, queue = [first], ids = [];
        unseen.delete(first);
        while (queue.length) {
          const id = queue.pop(); ids.push(id);
          for (const neighbor of adjacency.get(id) ?? []) if (unseen.delete(neighbor)) queue.push(neighbor);
        }
        const piece = ids.map(id => byId.get(id));
        const pieceIds = new Set(ids);
        if (piece.length < 3 || piece.some(c => !c.coordinate?.every(Number.isInteger))) continue;
        if (piece.some(c => (c.chartId ?? "chart:0") !== (piece[0].chartId ?? "chart:0"))) continue;
        const byCoordinate = new Map(piece.map(c => [keyOf(c.coordinate), c]));
        const pieceHasCountedSide = piece.some(copy => countedFaceCopies.has(copy.id));
        if (byCoordinate.size !== piece.length || !piece.every(c => neighbors.every(([dx,dy]) => {
          const other = byCoordinate.get(keyOf([c.coordinate[0]+dx,c.coordinate[1]+dy]));
          return !other || edges.has(edgeKey(c.id, other.id));
        }))) continue;
        const chart = copies.filter(c => (c.chartId ?? "chart:0") === (piece[0].chartId ?? "chart:0"));
        const minX = Math.min(...chart.map(c=>c.coordinate[0])), minY = Math.min(...chart.map(c=>c.coordinate[1]));
        const size = Math.max(5, Math.max(...chart.map(c=>c.coordinate[0])) - minX + Math.max(...chart.map(c=>c.coordinate[1])) - minY + 3);
        const shift = ([x,y]) => [x-minX+1,y-minY+1];
        const unshift = ([x,y]) => [x+minX-1,y+minY-1];
        const nodeState = 1 + 2*playerIndex, lineState = nodeState+1;
        const nodes = piece.filter(c=>snapshot.boardStates[c.canonicalVertexId] === nodeState).map(c=>shift(c.coordinate));
        const lines = piece.filter(c=>snapshot.boardStates[c.canonicalVertexId] === lineState).map(c=>shift(c.coordinate));
        const enemies = chart.filter(c => {
          const state = snapshot.boardStates[c.canonicalVertexId];
          return Number.isInteger(state) && state > 0 && state !== nodeState && state !== lineState;
        }).map(c=>shift(c.coordinate));
        const workspace = makeDisplayWorkspace(size);
        const result = workspace._computeRawTerritory(nodes, lines, enemies);
        if (!result.polygon) continue;
        const covered = workspace._getCoveredPoints(result.polygon);
        if (enemies.some(p => covered.has(keyOf(p)))) continue;
        const polygon = result.polygon.map(unshift);
        const area = polygon.reduce((sum,p,i)=>sum+p[0]*polygon[(i+1)%polygon.length][1]-p[1]*polygon[(i+1)%polygon.length][0],0);
        if (!area) continue;
        for (const face of view.faces ?? []) {
          if (filledFaces.has(face.id)) continue;
          // When the genuine walls resolve a counted side, a seam copy can
          // make the local contour enclose the opposite side too. Restrict
          // this candidate to the resolved side; open/ambiguous shapes still
          // retain the native contour when no such side is available.
          const faceCopies = (face.copyIds ?? []).map(id=>byId.get(id));
          if (faceCopies.length !== 3 || faceCopies.some(c=>!c || (c.chartId ?? "chart:0") !== (piece[0].chartId ?? "chart:0"))) continue;
          if (faceCopies.some(c => {
            const state = snapshot.boardStates[c.canonicalVertexId];
            return Number.isInteger(state) && state > 0 && state !== nodeState && state !== lineState;
          })) continue;
          // A different part of this connected wall can bound a counted
          // component without deciding the side of this local open contour.
          // Retain a V only when two actual edges of this same physical piece
          // meet on the face and all three vertices are owned. The raw contour
          // and face clipping below still decide whether any area is painted.
          const owned = faceCopies.every(c => pieceIds.has(c.id) && [nodeState, lineState].includes(snapshot.boardStates[c.canonicalVertexId]));
          const localEdges = (face.copyIds ?? []).filter((id, i) =>
            adjacency.get(id)?.has(face.copyIds[(i + 1) % 3])).length;
          if (pieceHasCountedSide && !countedFaces.has(face.id) && !(owned && localEdges >= 2)) continue;
          const clipped = clipToFace(polygon, faceCopies.map(c=>c.coordinate));
          const clippedArea = clipped.reduce((sum,p,i)=>sum+p[0]*clipped[(i+1)%clipped.length][1]-p[1]*clipped[(i+1)%clipped.length][0],0);
          if (clipped.length >= 3 && Math.abs(clippedArea) > 1e-9) regions.push({player, faceId:face.id, chartId:piece[0].chartId ?? "chart:0", kind:"face", polygon:clipped});
        }
      }
    }
    for (const player of PLAYER_ORDER) regions.push(...enclosedFaceRegions(snapshot, view, player));
    orientPieces(regions);
    cache.set(snapshot, { signature, polygons: regions });
    return regions;
  }
  const charts = new Map();
  for (const copy of copies) {
    const chart = copy.chartId ?? "chart:0";
    if (!charts.has(chart)) charts.set(chart, []);
    charts.get(chart).push(copy);
  }
  const polygons = [];
  for (const [chartId, chart] of charts) {
    if (chart.some((c) => !Array.isArray(c.coordinate) || c.coordinate.length !== 2
      || !c.coordinate.every(Number.isInteger))) continue;
    const coords = new Map();
    let ambiguous = false;
    for (const copy of chart) {
      const k = keyOf(copy.coordinate);
      if (coords.has(k)) { ambiguous = true; break; }
      coords.set(k, copy);
    }
    if (ambiguous) continue;
    const xs = chart.map((c) => c.coordinate[0]), ys = chart.map((c) => c.coordinate[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const size = Math.max(5, Math.max(...xs) - minX + Math.max(...ys) - minY + 3);
    const shift = ([x,y]) => [x - minX + 1, y - minY + 1];
    const unshift = ([x,y]) => [x + minX - 1, y + minY - 1];
    const engine = makeDisplayWorkspace(size);
    for (let index = 0; index < PLAYER_ORDER.length; index++) {
      const player = PLAYER_ORDER[index], stateNode = 1 + 2 * index, stateLine = stateNode + 1;
      const owned = chart.filter((c) => [stateNode, stateLine].includes(snapshot.boardStates[c.canonicalVertexId]));
      if (owned.length < 3) continue;
      // The native wall follower recognizes every geometric neighbour. Verify
      // those neighbours are actual atlas edges before allowing it to run.
      const ownedByCoord = new Map(owned.map((c) => [keyOf(c.coordinate), c]));
      const safe = owned.every((c) => neighbors.every(([dx,dy]) => {
        const other = ownedByCoord.get(keyOf([c.coordinate[0] + dx, c.coordinate[1] + dy]));
        return !other || edges.has(edgeKey(c.id, other.id));
      }));
      if (!safe) continue;
      const nodes = owned.filter((c) => snapshot.boardStates[c.canonicalVertexId] === stateNode).map((c) => shift(c.coordinate));
      const lines = owned.filter((c) => snapshot.boardStates[c.canonicalVertexId] === stateLine).map((c) => shift(c.coordinate));
      const enemies = chart.filter((c) => {
        const s = snapshot.boardStates[c.canonicalVertexId];
        return Number.isInteger(s) && s > 0 && s !== stateNode && s !== stateLine;
      }).map((c) => shift(c.coordinate));
      const result = engine._computeRawTerritory(nodes, lines, enemies);
      const polygon = result.polygon?.map(unshift);
      if (!polygon || polygon.length < 4) continue;
      // The native non-closed mode permits open chains but does not reject an
      // enemy contained by its initial contour. Never paint through an enemy.
      const covered = engine._getCoveredPoints(result.polygon);
      if (enemies.some(point => covered.has(keyOf(point)))) continue;
      const signed = polygon.slice(0, -1).reduce((sum, p, i) => sum + p[0] * polygon[i+1][1] - p[1] * polygon[i+1][0], 0);
      if (signed === 0) continue;
      // The legacy contour is only a candidate: intersect it with each
      // genuine face so cutouts and missing board patches stay unpainted.
      const byId = new Map(chart.map(copy => [copy.id, copy]));
      for (const face of view.faces ?? []) {
        const vertices = (face.copyIds ?? []).map(id => byId.get(id));
        if (vertices.length !== 3 || vertices.some(copy => !copy)) continue;
        const clipped = clipToFace(polygon, vertices.map(copy => copy.coordinate));
        const area = clipped.reduce((sum, p, i) => sum + p[0]*clipped[(i+1)%clipped.length][1] - p[1]*clipped[(i+1)%clipped.length][0], 0);
        if (clipped.length >= 3 && Math.abs(area) > 1e-9) polygons.push({ player, faceId:face.id, chartId, kind:"face", polygon:clipped });
      }
    }
  }
  // Closed enemy-free components are independent of whether another piece of
  // this player's native contour was rendered elsewhere on the chart.
  for (const player of PLAYER_ORDER) {
    polygons.push(...enclosedFaceRegions(snapshot, view, player));
  }
  orientPieces(polygons);
  cache.set(snapshot, { signature, polygons });
  return polygons;
}

export function pointInDisplayPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
