import { MongoClient } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../logger.js';

const client = new MongoClient(config.MONGODB_URL, {
  serverSelectionTimeoutMS: 5000,
  maxPoolSize: 20,
});

let connected = false;

export const connectMongo = async () => {
  if (!connected) {
    await client.connect();
    connected = true;
    logger.info('mongodb connected');
  }
  return client.db(config.MONGODB_DB);
};

export const mongoDb = () => client.db(config.MONGODB_DB);

export const activityEvents = () => mongoDb().collection('activity_events');
export const reportSnapshots = () => mongoDb().collection('report_snapshots');

// Created by the writer rather than by a migration: MongoDB has no migration step in
// this project, and an index that only exists on a developer's machine is worse than
// no index at all. createIndex is idempotent, so calling it on every boot is safe.
export const ensureIndexes = async () => {
  await activityEvents().createIndexes([
    // The read pattern: one user's history, newest first.
    { key: { userId: 1, occurredAt: -1 }, name: 'user_time' },
    // Filtering that history by what happened.
    { key: { userId: 1, eventType: 1, occurredAt: -1 }, name: 'user_type_time' },
    // The durable guard against a redelivered event becoming a second history entry.
    // processed_events already prevents it; this makes it impossible rather than
    // merely prevented, and it is what the writer relies on to stay idempotent.
    { key: { eventId: 1 }, name: 'event_id_unique', unique: true },
  ]);

  await reportSnapshots().createIndexes([
    // A report for a user, a type and a period is one document. Regenerating replaces
    // it rather than accumulating versions, so this index is also the upsert key.
    { key: { userId: 1, reportType: 1, periodStart: 1 }, name: 'user_type_period', unique: true },
    { key: { userId: 1, generatedAt: -1 }, name: 'user_generated' },
  ]);

  logger.info('mongodb indexes ensured');
};

export const disconnectMongo = async () => {
  if (!connected) return;
  await client.close();
  connected = false;
};
