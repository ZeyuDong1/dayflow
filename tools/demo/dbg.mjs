import { launchApp, closeApp } from './common.mjs'
const { app } = await launchApp()
await new Promise((r) => setTimeout(r, 8000))
for (const w of app.windows()) {
  const html = await w.content()
  console.log('---', w.url().split('/').pop(), '| title:', await w.title(), '| len:', html.length, '| sidebar:', html.includes('sidebar'), '| visible:', w.isVisible ? '' : '')
}
await closeApp(app)
process.exit(0)
