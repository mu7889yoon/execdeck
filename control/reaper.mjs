import { createMicrovms, store } from './aws-services.mjs'

const microvms = createMicrovms()

async function terminate(microvmId) {
  const input = { microvmIdentifier: microvmId }
  try {
    const vm = await microvms.get(input)
    if (!['TERMINATING', 'TERMINATED'].includes(vm.state)) await microvms.terminate(input)
    return true
  } catch (error) {
    if (['ResourceNotFoundException', 'NotFoundException'].includes(error?.name)) return false
    throw error
  }
}

export async function handler() {
  const sessions = await store.expiredSessions(Math.floor(Date.now() / 1000))
  const results = { found: sessions.length, terminated: 0, deferred: 0 }
  for (const session of sessions) {
    try {
      if (session.microvmId && await terminate(session.microvmId)) results.terminated++
      await store.releaseSession(session)
    } catch (error) {
      results.deferred++
      console.warn('Expired MicroVM cleanup deferred:', error.name || 'Error')
    }
  }
  console.log(JSON.stringify(results))
  return results
}
