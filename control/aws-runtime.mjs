import { createMicrovms, region, store } from './aws-services.mjs'
import { createHandler } from './handler.mjs'

export const handler = createHandler({
  store,
  microvms: createMicrovms(8),
  config: {
    imageArn: process.env.MICROVM_IMAGE_ARN,
    maxSessions: Number(process.env.MAX_SESSIONS || 30),
    sessionTTLSeconds: Number(process.env.SESSION_TTL_SECONDS || 3600),
    originVerifyToken: process.env.ORIGIN_VERIFY_TOKEN,
    ingressConnectorArn: `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
    egressConnectorArn: process.env.EGRESS_CONNECTOR_ARN,
  },
})
