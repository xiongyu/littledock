export function activate(api) {
  let latest = { available: false, revision: 0 }
  api.interop.subscribe('example.counter', 1, 'state', snapshot => { latest = snapshot })
  api.registerRpc('state', { mutate: false, maintenance: 'read', handler: () => latest })
  api.registerRpc('add', { mutate: true, handler: (_owner, input) => api.interop.call('example.counter', 1, 'add', input) })
}
