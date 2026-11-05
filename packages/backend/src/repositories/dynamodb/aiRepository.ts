import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { PersistenceError } from '../../lib/errors';
import { clampPage, compareBinary } from '../common';
import type { AIAnalysisRecord, AIAnalysisRepository, NewAIAnalysis, PageResult } from '../types';
import type { DynamoRepositoryContext } from './index';
import { analysisItem, itemToAnalysis, type StoredItem } from './items';
import { AI_ANALYSIS_PK, ALERT_PK, alertKey, analysisKey, fitsKey } from './keys';
import { CONDITIONAL_CHECK_FAILED, isConditionalCheckFailed, partitionQuery, queryAll, queryCount, send } from './ops';

/** AI analyses, DynamoDB driver (design §5.3 patterns 33–36). */
export function dynamoAIAnalysisRepository(ctx: DynamoRepositoryContext): AIAnalysisRepository {
  /** An alertId must name an existing alert (SQLite's foreign key); an existing id raises DUPLICATE. */
  async function insert(rec: NewAIAnalysis): Promise<string> {
    const op = 'aiAnalyses.insert';
    const id = rec.id ?? randomUUID();
    const item = analysisItem({ ...rec, id }, ctx.now());
    if (rec.alertId != null) {
      const notFound = () => new PersistenceError('REFERENCE_NOT_FOUND', 'Referenced record not found');
      if (!fitsKey(ALERT_PK, rec.alertId)) throw notFound();
      const alert = await send(
        ctx,
        new GetCommand({
          TableName: ctx.tableName,
          Key: alertKey(rec.alertId),
          ConsistentRead: true,
          ProjectionExpression: '#pk',
          ExpressionAttributeNames: { '#pk': 'PK' },
        }),
        op,
      );
      if (!alert.Item) throw notFound();
    }
    try {
      await send(
        ctx,
        new PutCommand({
          TableName: ctx.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(#pk)',
          ExpressionAttributeNames: { '#pk': 'PK' },
        }),
        op,
        { handled: [CONDITIONAL_CHECK_FAILED] },
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) throw new PersistenceError('DUPLICATE', 'Record already exists');
      throw err;
    }
    return id;
  }

  async function query(opts: { page?: number; pageSize?: number }): Promise<PageResult<AIAnalysisRecord>> {
    const all = await queryAll<StoredItem>(ctx, partitionQuery(AI_ANALYSIS_PK), 'aiAnalyses.query');
    all.sort((x, y) => compareBinary(y.timestamp, x.timestamp) || compareBinary(y.id, x.id));
    const { offset, pageSize } = clampPage(opts.page, opts.pageSize, 25);
    return { items: all.slice(offset, offset + pageSize).map(itemToAnalysis), total: all.length };
  }

  async function findById(id: string): Promise<AIAnalysisRecord | null> {
    if (!fitsKey(AI_ANALYSIS_PK, id)) return null;
    const res = await send(
      ctx,
      new GetCommand({ TableName: ctx.tableName, Key: analysisKey(id), ConsistentRead: true }),
      'aiAnalyses.findById',
    );
    return res.Item ? itemToAnalysis(res.Item) : null;
  }

  async function count(): Promise<number> {
    return queryCount(ctx, partitionQuery(AI_ANALYSIS_PK), 'aiAnalyses.count');
  }

  return { insert, query, findById, count };
}
