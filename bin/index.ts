import { Config } from "../src/config";
import { Server } from "../src/server";
import fs from "fs/promises";
import path from "path";

/**
 * Gets the contents of the config file at the given path.
 *
 * @param configPath - The path to the config file (default `__dirname/config.json`)
 */
async function loadConfig(configPath: string = path.join(__dirname, "config.json")): Promise<Config> {
  console.log("Loading config.json");

  return JSON.parse(await fs.readFile(configPath, "utf-8"));
}

(async (): Promise<void> => {
  try {
    const config = await loadConfig();
    const server = new Server(config);

    await server.listen();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
