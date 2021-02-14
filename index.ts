import { Server } from "./lib/server";
import fs from "fs";

export interface Config {
  /*redis: {
    host: string;
    port: 
  };*/
  server: {
    host: string;
    port: number;
  };
}

const config: Config = JSON.parse(fs.readFileSync("config.json", "utf-8"));
const server = new Server(config);

server.listen();
