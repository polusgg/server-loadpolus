import Redis from "ioredis";

export interface Config {
  server: {
    host: string;
    port: number;
    publicIp: string;
    name: string;
  };
  redis: Redis.RedisOptions;
}
