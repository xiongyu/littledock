export function activate(api) {
  let value = 0
  const operations = new Map()
  api.interop.register('example.counter', 1, {
    read: () => ({ value }),
    add: (input, context) => {
      const key = `${context.owner ?? context.caller}:${input.operationId}`
      if (operations.has(key)) return operations.get(key)
      value += input.amount
      const result = { value }; operations.set(key, result)
      if (operations.size > 128) operations.delete(operations.keys().next().value)
      api.interop.publish('example.counter', 1, 'state', result)
      return result
    },
  }, { state: { value } })
  api.registerRpc('read', { mutate: false, maintenance: 'read', handler: () => ({ value }) })
}
