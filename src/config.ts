import Redis from "ioredis";

export type Config = {
  server: {
    host: string;
    port: number;
    publicIp: string;
    name: string;
  };
  redis: Redis.RedisOptions;
  debug: boolean;
};
