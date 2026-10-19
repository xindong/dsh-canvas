import { denseRegions } from './dense-regions.js'

export function resolveViewport(input, document) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('viewport must be an object')
  const action = input.action
  if (!['fit', 'center', 'zoom', 'pan', 'reset'].includes(action)) throw new TypeError('viewport.action must be fit, center, zoom, pan or reset')
  const number = (key, fallback, positive = false) => {
    const value = input[key] ?? fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || (positive && (value <= 0 || value > 100))) throw new TypeError(`viewport.${key} is invalid`)
    return value
  }
  if (action === 'pan') return { action, dx: number('dx', 0), dy: number('dy', 0) }
  if (action === 'reset') return { action }
  if (action === 'zoom') {
    if (input.scale !== undefined && input.factor !== undefined) throw new TypeError('Specify scale or factor, not both')
    if (input.scale === undefined && input.factor === undefined) throw new TypeError('zoom requires scale or factor')
    return input.scale !== undefined ? { action, scale: number('scale', 1, true) } : { action, factor: number('factor', 1, true) }
  }
  const padding = number('padding', 72)
  if (padding < 0 || padding > 500) throw new TypeError('viewport.padding must be between 0 and 500 CSS pixels')
  const scale = input.scale === undefined ? undefined : number('scale', 1, true)
  const targets = ['bounds', 'center', 'node_ids', 'target'].filter(key => input[key] !== undefined)
  if (targets.length > 1) throw new TypeError('Specify one viewport target: bounds, center, node_ids or target')
  let bounds
  if (input.bounds !== undefined) {
    if (!input.bounds || typeof input.bounds !== 'object') throw new TypeError('viewport.bounds is invalid')
    bounds = Object.fromEntries(['minX', 'minY', 'maxX', 'maxY'].map(key => {
      const value = input.bounds[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`viewport.bounds.${key} must be finite`)
      return [key, value]
    }))
    if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY) throw new TypeError('viewport.bounds must be ordered')
  } else if (input.center !== undefined) {
    if (action !== 'center') throw new TypeError('viewport.center requires action=center')
    const { x, y } = input.center || {}
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('viewport.center requires finite x,y')
    bounds = { minX: x, maxX: x, minY: y, maxY: y }
  } else {
    let nodes = document.nodes.filter(node => node.visible !== false)
    if (input.node_ids !== undefined) {
      if (!Array.isArray(input.node_ids) || !input.node_ids.length || input.node_ids.some(id => typeof id !== 'string')) throw new TypeError('viewport.node_ids must be non-empty string array')
      const ids = new Set(input.node_ids)
      nodes = document.nodes.filter(node => ids.has(node.id))
      if (nodes.length !== ids.size) throw new TypeError('viewport target node does not exist')
    } else if (input.target !== undefined && !['all', 'dense'].includes(input.target)) throw new TypeError('viewport.target must be all or dense')
    if (!nodes.length) throw new TypeError('No nodes to focus; use viewport reset for an empty board')
    if (input.target === 'dense' && !input.node_ids) bounds = denseRegions(nodes, 1)[0].bounds
    else {
      bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
      for (const node of nodes) {
        const cos = Math.cos(node.rotation || 0), sin = Math.sin(node.rotation || 0)
        for (const [x, y] of [[0, 0], [node.width, 0], [node.width, node.height], [0, node.height]]) {
          const px = node.x + x * cos - y * sin, py = node.y + x * sin + y * cos
          bounds.minX = Math.min(bounds.minX, px); bounds.maxX = Math.max(bounds.maxX, px)
          bounds.minY = Math.min(bounds.minY, py); bounds.maxY = Math.max(bounds.maxY, py)
        }
      }
    }
  }
  return { action, bounds, padding, ...(scale === undefined ? {} : { scale }) }
}
