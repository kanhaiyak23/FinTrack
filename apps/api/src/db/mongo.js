import { MongoClient } from 'mongodb';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

const client = new MongoClient(config.MONGODB_URL, {
  serverSelectionTimeoutMS: 5000,
  maxPoolSize: 20,
});

let connected = false;

export const connectMongo = async () => {
  if (connected) return client.db(config.MONGODB_DB);
  await client.connect();
  connected = true;
  logger.info('mongodb connected');
  return client.db(config.MONGODB_DB);
};

export const mongoDb = () => client.db(config.MONGODB_DB);

export const checkMongo = async () => {
  await client.db(config.MONGODB_DB).command({ ping: 1 });
  return true;
};

export const disconnectMongo = async () => {
  if (!connected) return;
  await client.close();
  connected = false;
  logger.info('mongodb disconnected');
};
