import { Config } from "./lib/config";
import { Server } from "./lib/server";
import fs from "fs";

const config: Config = JSON.parse(fs.readFileSync("config.json", "utf-8"));
const server = new Server(config);

server.listen();
