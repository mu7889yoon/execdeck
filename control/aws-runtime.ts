import { createMicrovms, region, store } from './aws-services.ts'
import { createHandler } from './handler.ts'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

export const handler = createHandler({
  store,
  microvms: createMicrovms(8),
  config: {
    imageArn: requiredEnv('MICROVM_IMAGE_ARN'),
    maxSessions: Number(process.env.MAX_SESSIONS || 30),
    sessionTTLSeconds: Number(process.env.SESSION_TTL_SECONDS || 3600),
    originVerifyToken: process.env.ORIGIN_VERIFY_TOKEN,
    ingressConnectorArn: `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
    egressConnectorArn: requiredEnv('EGRESS_CONNECTOR_ARN'),
  },
})
