import Redis from "ioredis";

export type Config = {
  server: {
    host: string;
    port: number;
    publicIp: string;
  };
  redis: Redis.RedisOptions;
};
