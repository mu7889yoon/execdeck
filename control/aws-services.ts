import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  type TransactWriteCommandInput,
  type ScanCommandInput,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  LambdaMicrovmsClient,
  RunMicrovmCommand, type RunMicrovmRequest,
  GetMicrovmCommand, type GetMicrovmRequest,
  CreateMicrovmAuthTokenCommand, type CreateMicrovmAuthTokenRequest,
  TerminateMicrovmCommand, type TerminateMicrovmRequest,
} from '@aws-sdk/client-lambda-microvms'

export type Session = {
  pk: string
  sid: string
  joinKey: string
  createdAt: number
  expiresAt: number
  status: 'LAUNCHING' | 'STARTING' | 'READY' | 'TERMINATING'
  microvmId?: string
  endpoint?: string
}

type TransactionItems = NonNullable<TransactWriteCommandInput['TransactItems']>

export const region = process.env.AWS_REGION || 'ap-northeast-1'
const tableName = process.env.SESSION_TABLE
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
})

async function getItem<T>(pk: string) {
  const { Item } = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { pk },
    ConsistentRead: true,
  }))
  return Item as T | undefined
}

async function tryTransaction(items: TransactionItems) {
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }))
    return true
  } catch (error) {
    if (error instanceof Error && error.name === 'TransactionCanceledException') return false
    throw error
  }
}

export const store = {
  getSession(sid: string) {
    return getItem<Session>(`SESSION#${sid}`)
  },

  getJoin(joinKey: string) {
    return getItem<{ sid: string }>(`JOIN#${joinKey}`)
  },

  async deleteJoin(joinKey: string) {
    await ddb.send(new DeleteCommand({ TableName: tableName, Key: { pk: `JOIN#${joinKey}` } }))
  },

  reserveSession(session: Session, maxSessions: number) {
    return tryTransaction([
      {
        Put: {
          TableName: tableName,
          Item: { ...session, counted: true },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: `JOIN#${session.joinKey}`,
            sid: session.sid,
            expiresAt: session.expiresAt,
            createdAt: session.createdAt,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Update: {
          TableName: tableName,
          Key: { pk: 'CONTROL#ACTIVE' },
          UpdateExpression: 'SET activeSessions = if_not_exists(activeSessions, :zero) + :one',
          ConditionExpression: 'attribute_not_exists(activeSessions) OR activeSessions < :max',
          ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':max': maxSessions },
        },
      },
    ])
  },

  async updateSession(pk: string, changes: Pick<Session, 'status' | 'microvmId' | 'endpoint'>, expectedStatus?: Session['status']) {
    const pairs = Object.entries(changes).filter(([, value]) => value !== undefined)
    if (!pairs.length) return
    const names: Record<string, string> = {}
    const values: Record<string, string> = {}
    const assignments = pairs.map(([key, value], index) => {
      names[`#n${index}`] = key
      values[`:v${index}`] = value
      return `#n${index} = :v${index}`
    })
    if (expectedStatus) {
      names['#status'] = 'status'
      values[':expected'] = expectedStatus
    }
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk },
      UpdateExpression: `SET ${assignments.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: expectedStatus ? '#status = :expected' : 'attribute_exists(pk)',
    }))
  },

  releaseSession(session: Session) {
    const items: TransactionItems = [
      {
        Delete: {
          TableName: tableName,
          Key: { pk: session.pk },
          ConditionExpression: 'counted = :true',
          ExpressionAttributeValues: { ':true': true },
        },
      },
      {
        Update: {
          TableName: tableName,
          Key: { pk: 'CONTROL#ACTIVE' },
          UpdateExpression: 'ADD activeSessions :minusOne',
          ConditionExpression: 'activeSessions >= :one',
          ExpressionAttributeValues: { ':minusOne': -1, ':one': 1 },
        },
      },
    ]
    if (session.joinKey) {
      items.push({ Delete: { TableName: tableName, Key: { pk: `JOIN#${session.joinKey}` } } })
    }
    return tryTransaction(items)
  },

  async expiredSessions(now: number) {
    const sessions: Session[] = []
    let ExclusiveStartKey: ScanCommandInput['ExclusiveStartKey']
    do {
      const result = await ddb.send(new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey,
        FilterExpression: 'begins_with(pk, :prefix) AND (expiresAt <= :now OR #status = :terminating)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':prefix': 'SESSION#', ':now': now, ':terminating': 'TERMINATING' },
      }))
      sessions.push(...((result.Items || []) as Session[]))
      ExclusiveStartKey = result.LastEvaluatedKey
    } while (ExclusiveStartKey)
    return sessions
  },
}

export function createMicrovms(maxAttempts?: number) {
  const client = new LambdaMicrovmsClient({ region, maxAttempts })
  return {
    run(input: RunMicrovmRequest) { return client.send(new RunMicrovmCommand(input)) },
    get(input: GetMicrovmRequest) { return client.send(new GetMicrovmCommand(input)) },
    createAuthToken(input: CreateMicrovmAuthTokenRequest) { return client.send(new CreateMicrovmAuthTokenCommand(input)) },
    terminate(input: TerminateMicrovmRequest) { return client.send(new TerminateMicrovmCommand(input)) },
  }
}
