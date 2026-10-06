/**
 * The shape of a group of agents: who waits for whom. Shared by the main
 * process (which runs the graph) and the renderer (which draws it).
 */
export interface GraphShape {
  id: string;
  dependsOn: string[];
}

/** Why a graph can't run, or null when it can: every id once, every dependency present, and no loops. */
export function validateGraph(nodes: GraphShape[]): string | null {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) return `The id "${node.id}" is used twice. Give every agent its own id.`;
    ids.add(node.id);
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (dep === node.id) return `"${node.id}" depends on itself.`;
      if (!ids.has(dep)) return `"${node.id}" depends on "${dep}", which isn't one of the agents.`;
    }
  }
  // Kahn's algorithm: whatever can't be ordered sits on a loop.
  const waiting = new Map(nodes.map((n) => [n.id, new Set(n.dependsOn)]));
  for (;;) {
    const ready = [...waiting.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (ready.length === 0) break;
    for (const id of ready) waiting.delete(id);
    for (const deps of waiting.values()) for (const id of ready) deps.delete(id);
  }
  return waiting.size > 0 ? `These agents wait on each other in a loop: ${[...waiting.keys()].join(', ')}.` : null;
}

/** The step each agent runs in: 0 for those that wait for nothing, otherwise one after the latest thing it depends on. */
export function graphDepths(nodes: GraphShape[]): Record<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depths: Record<string, number> = {};
  const depthOf = (id: string, seen: Set<string>): number => {
    const known = depths[id];
    if (known !== undefined) return known;
    const node = byId.get(id);
    // A loop or a missing dependency is refused by validateGraph; here it just stops the walk.
    if (!node || seen.has(id)) return 0;
    seen.add(id);
    const depth = node.dependsOn.length === 0 ? 0 : 1 + Math.max(...node.dependsOn.map((dep) => depthOf(dep, seen)));
    depths[id] = depth;
    return depth;
  };
  for (const node of nodes) depthOf(node.id, new Set());
  return depths;
}
