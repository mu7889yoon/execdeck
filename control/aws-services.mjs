import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { LambdaMicrovmsClient, RunMicrovmCommand, GetMicrovmCommand, CreateMicrovmAuthTokenCommand, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms'

export const region = process.env.AWS_REGION || 'ap-northeast-1'
const tableName = process.env.SESSION_TABLE
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
})

async function getItem(pk) {
  const { Item } = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { pk },
    ConsistentRead: true,
  }))
  return Item
}

async function tryTransaction(items) {
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }))
    return true
  } catch (error) {
    if (error.name === 'TransactionCanceledException') return false
    throw error
  }
}

export const store = {
  getSession(sid) {
    return getItem(`SESSION#${sid}`)
  },

  getJoin(joinKey) {
    return getItem(`JOIN#${joinKey}`)
  },

  async deleteJoin(joinKey) {
    await ddb.send(new DeleteCommand({ TableName: tableName, Key: { pk: `JOIN#${joinKey}` } }))
  },

  reserveSession(session, maxSessions) {
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

  async updateSession(pk, changes) {
    const pairs = Object.entries(changes).filter(([, value]) => value !== undefined)
    if (!pairs.length) return
    const names = {}
    const values = {}
    const assignments = pairs.map(([key, value], index) => {
      names[`#n${index}`] = key
      values[`:v${index}`] = value
      return `#n${index} = :v${index}`
    })
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk },
      UpdateExpression: `SET ${assignments.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(pk)',
    }))
  },

  async releaseSession(session) {
    const current = await getItem(session.pk)
    if (!current) return false
    if (!current.counted) {
      await ddb.send(new DeleteCommand({ TableName: tableName, Key: { pk: session.pk } }))
      return false
    }
    const items = [
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
    if (current.joinKey) {
      items.push({ Delete: { TableName: tableName, Key: { pk: `JOIN#${current.joinKey}` } } })
    }
    return tryTransaction(items)
  },

  async expiredSessions(now) {
    const sessions = []
    let ExclusiveStartKey
    do {
      const result = await ddb.send(new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey,
        FilterExpression: 'begins_with(pk, :prefix) AND (expiresAt <= :now OR #status = :terminating)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':prefix': 'SESSION#', ':now': now, ':terminating': 'TERMINATING' },
      }))
      sessions.push(...(result.Items || []))
      ExclusiveStartKey = result.LastEvaluatedKey
    } while (ExclusiveStartKey)
    return sessions
  },
}

export function createMicrovms(maxAttempts) {
  const client = new LambdaMicrovmsClient({ region, maxAttempts })
  return {
    run(input) { return client.send(new RunMicrovmCommand(input)) },
    get(input) { return client.send(new GetMicrovmCommand(input)) },
    createAuthToken(input) { return client.send(new CreateMicrovmAuthTokenCommand(input)) },
    terminate(input) { return client.send(new TerminateMicrovmCommand(input)) },
  }
}
