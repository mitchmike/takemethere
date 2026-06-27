import Redis from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.REDIS_URL);
export const redisSub = new Redis(config.REDIS_URL);
