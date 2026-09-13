/**
 * Minimal static server for the example page.
 *
 * Why this exists: the components are ES modules, and browsers refuse to load
 * modules over file:// (CORS). A demo that only works after you install and
 * configure something is not a demo, so this uses nothing but node:http.
 *
 *   node serve.js [port]
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PORT = Number(process.argv[2] || 4173)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
}

/** Resolve a URL path inside ROOT, or null if it escapes (path traversal). */
function resolveSafe(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0])
  const rel = normalize(decoded).replace(/^([/\\])+/, '')
  const full = join(ROOT, rel)
  if (!full.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return null
  return full
}

const server = createServer(async (req, res) => {
  try {
    let target = resolveSafe(req.url || '/')
    if (!target) { res.writeHead(403).end('forbidden'); return }

    let info = await stat(target).catch(() => null)
    if (info && info.isDirectory()) {
      target = join(target, 'index.html')
      info = await stat(target).catch(() => null)
    }
    if (!info) {
      // Directory listings are not needed; point at the example instead.
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found. try /example.html')
      return
    }

    const body = await readFile(target)
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] || 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('server error: ' + error.message)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dsh-charts example: http://127.0.0.1:${PORT}/example.html`)
})
