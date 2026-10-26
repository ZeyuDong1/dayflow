import { WandbPoller } from '../src/main/todo/wandb/poller.ts'
const run = { id: 'run1', name: 'display1', state: 'running', config: {}, summaryMetrics: {} }
let runs = [run]
let stateImpl = async (_e, _p, id) => (id === 'run1' ? null : 'finished')
const client = {
  getRecentProjects: async () => ['p1'],
  getRunningRuns: async () => runs,
  getRunState: (...a) => stateImpl(...a),
}
const events = []
const poller = new WandbPoller({ client, entity: 'ent', intervalMs: 60000, onPoll: (r) => events.push(r) })
await poller.poll()
console.log('P1 events', events.length, JSON.stringify(events[0]?.active?.length))
runs = []
await poller.poll()
console.log('P2 events', events.length, 'tracked', poller.trackedRuns.has('run1'))
stateImpl = async () => 'finished'
await poller.poll()
console.log('P3 events', events.length, JSON.stringify(events[1]?.finished?.length), 'tracked', poller.trackedRuns.has('run1'))
