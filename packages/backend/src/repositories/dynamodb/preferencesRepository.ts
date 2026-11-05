import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PersistenceError } from '../../lib/errors';
import { parsePreferencesPatch, parseReadId } from '../validation';
import type { PreferencesPatch, PreferencesRepository, UserPreferences } from '../types';
import type { DynamoRepositoryContext } from './index';
import { itemToPreferences, type StoredItem } from './items';
import { prefsKey, userKey } from './keys';
import { send } from './ops';

/**
 * User preferences, DynamoDB driver (design §5.3 patterns 8–9). One `PREFS/<userId>` item per user. The
 * user must exist, whatever isActive is.
 */
export function dynamoPreferencesRepository(ctx: DynamoRepositoryContext): PreferencesRepository {
  async function get(userId: string): Promise<UserPreferences | null> {
    const id = parseReadId(userId);
    const res = await send(
      ctx,
      new GetCommand({ TableName: ctx.tableName, Key: prefsKey(id), ConsistentRead: true }),
      'preferences.get',
    );
    return res.Item ? itemToPreferences(res.Item) : null;
  }

  /**
   * Check the user, then one UpdateItem that SETs the supplied fields, updatedAt, #userId and #entityType,
   * so an item created by this call is complete. undefined keeps a field, null clears it.
   */
  async function update(userId: string, patch: PreferencesPatch): Promise<UserPreferences> {
    const p = parsePreferencesPatch(userId, patch);
    const op = 'preferences.update';
    const user = await send(
      ctx,
      new GetCommand({
        TableName: ctx.tableName,
        Key: userKey(p.userId),
        ConsistentRead: true,
        ProjectionExpression: '#pk',
        ExpressionAttributeNames: { '#pk': 'PK' },
      }),
      op,
    );
    if (!user.Item) throw new PersistenceError('REFERENCE_NOT_FOUND', 'Referenced record not found');

    const sets = ['#updatedAt = :updatedAt', '#userId = :userId', '#entityType = :entityType'];
    const names: Record<string, string> = { '#updatedAt': 'updatedAt', '#userId': 'userId', '#entityType': 'entityType' };
    const values: Record<string, unknown> = { ':updatedAt': ctx.now(), ':userId': p.userId, ':entityType': 'PREFS' };
    if (p.theme !== undefined) {
      sets.push('#theme = :theme');
      names['#theme'] = 'theme';
      values[':theme'] = p.theme;
    }
    if (p.widgetLayout !== undefined) {
      sets.push('#widgetLayoutJson = :widgetLayoutJson');
      names['#widgetLayoutJson'] = 'widgetLayoutJson';
      values[':widgetLayoutJson'] = p.widgetLayout === null ? null : JSON.stringify(p.widgetLayout);
    }
    const res = await send(
      ctx,
      new UpdateCommand({
        TableName: ctx.tableName,
        Key: prefsKey(p.userId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
      op,
    );
    return itemToPreferences(res.Attributes as StoredItem);
  }

  return { get, update };
}
