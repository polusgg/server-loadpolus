import { Server } from "./lib/server";
import fs from "fs";
import redis from "redis";

export interface Config {
  redis: redis.ClientOpts;
  server: {
    host: string;
    port: number;
  };
}

const config: Config = JSON.parse(fs.readFileSync("config.json", "utf-8"));
const server = new Server(config);

server.listen();
