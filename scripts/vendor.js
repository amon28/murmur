// Copies the browser builds of the chat's formatting libraries into renderer/vendor (git-ignored), so the window loads
// them from the app itself: offline, and allowed by its Content-Security-Policy ('self'). Runs before `npm start` and
// `npm run dist`.
const fs = require('fs'), path = require('path')
const root = path.join(__dirname, '..'), out = path.join(root, 'renderer', 'vendor')
const files = {
  'marked.umd.js': 'marked/lib/marked.umd.js', // Markdown
  'purify.min.js': 'dompurify/dist/purify.min.js', // cleans the HTML before it is shown
  'highlight.min.js': '@highlightjs/cdn-assets/highlight.min.js', // colours in code
  'github-dark.min.css': '@highlightjs/cdn-assets/styles/github-dark.min.css',
  'mermaid.min.js': 'mermaid/dist/mermaid.min.js', // diagrams, loaded only when a reply has one
}
fs.mkdirSync(out, { recursive: true })
for (const [to, from] of Object.entries(files)) fs.copyFileSync(path.join(root, 'node_modules', from), path.join(out, to)) // straight from node_modules: some packages hide these paths from require
console.log('vendor: copied', Object.keys(files).length, 'files to renderer/vendor')
