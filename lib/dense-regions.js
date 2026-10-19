// Spatial-hash local density, not all-pairs clustering. Nine counter updates
// per visible node; ranking costs O(k log k), with k <= 9n occupied windows.
export function denseRegions(nodes, maxRegions = 5) {
  const boxes = nodes.filter(node => node.visible !== false).map(node => {
    const cos = Math.cos(node.rotation || 0), sin = Math.sin(node.rotation || 0)
    const corners = [[0, 0], [node.width, 0], [node.width, node.height], [0, node.height]]
      .map(([x, y]) => ({ x: node.x + x * cos - y * sin, y: node.y + x * sin + y * cos }))
    const minX = Math.min(...corners.map(p => p.x)), maxX = Math.max(...corners.map(p => p.x))
    const minY = Math.min(...corners.map(p => p.y)), maxY = Math.max(...corners.map(p => p.y))
    return { id: node.id, minX, minY, maxX, maxY, x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  }).filter(box => Object.values(box).every(value => typeof value !== 'number' || Number.isFinite(value)))
  if (!boxes.length) return []
  const sizes = boxes.map(box => Math.max(box.maxX - box.minX, box.maxY - box.minY)).sort((a, b) => a - b)
  const cellSize = Math.max(64, Math.min(2048, sizes[Math.floor(sizes.length / 2)] * 1.5))
  const cells = new Map(), windows = new Map()
  for (const box of boxes) {
    const x = Math.floor(box.x / cellSize), y = Math.floor(box.y / cellSize)
    const key = `${x}:${y}`
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push(box)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const key = `${x + dx}:${y + dy}`
      if (!windows.has(key)) windows.set(key, { x: x + dx, y: y + dy, count: 0 })
      windows.get(key).count++
    }
  }
  const ranked = [...windows.values()].sort((a, b) => b.count - a.count || a.x - b.x || a.y - b.y)
  const usedCells = new Set(), regions = []
  for (const window of ranked) {
    const keys = []
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) keys.push(`${window.x + dx}:${window.y + dy}`)
    if (keys.some(key => usedCells.has(key))) continue
    const members = []
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const box of cells.get(`${window.x + dx}:${window.y + dy}`) || []) members.push(box)
    }
    if (!members.length) continue
    for (const key of keys) usedCells.add(key)
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    for (const box of members) {
      bounds.minX = Math.min(bounds.minX, box.minX); bounds.minY = Math.min(bounds.minY, box.minY)
      bounds.maxX = Math.max(bounds.maxX, box.maxX); bounds.maxY = Math.max(bounds.maxY, box.maxY)
    }
    regions.push({ bounds, nodeCount: members.length, nodeIds: members.slice(0, 500).map(box => box.id), truncated: members.length > 500 })
    if (regions.length >= maxRegions) break
  }
  return regions
}
