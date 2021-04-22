import { Level, PacketDestination, RootPacketType } from "@nodepolus/framework/src/types/enums";
import { ClientVersion, ConnectionInfo, DisconnectReason, LobbyListing, Mutable } from "@nodepolus/framework/src/types";
import { MessageReader } from "@nodepolus/framework/src/util/hazelMessage";
import { Connection } from "@nodepolus/framework/src/protocol/connection";
import { MaxValue, SUPPORTED_VERSIONS } from "@nodepolus/framework/src/util/constants";
import { TextComponent } from "@nodepolus/framework/src/api/text";
import { CancelJoinGamePacket } from "./cancelJoinGamePacket";
import { AuthHandler } from "./auth";
import { Config } from "./config";
import Redis from "ioredis";
import dgram from "dgram";
import os from "os";
import {
  BaseRootPacket,
  GetGameListResponsePacket,
  HostGameResponsePacket,
  JoinedGamePacket,
  RedirectPacket,
} from "@nodepolus/framework/src/protocol/packets/root";
import { UserResponseStructure } from "@polusgg/module-polusgg-auth-api/src/types/userResponseStructure";
import { readFileSync } from "fs";
import got from "got";

const isInDocker = (): boolean => {
  const platform = os.platform();

  if (platform === "darwin" || platform === "win32") {
    return false;
  }

  const file = readFileSync("/proc/self/cgroup", "utf-8");

  return file.indexOf("/docker") !== -1;
};

const getMeta = async (path: string): Promise<string | undefined> => {
  path = path.startsWith("/") ? path.substr(1) : path;

  try {
    const { body } = await got(`http://169.254.169.254/metadata/v1/${path}`);

    return body;
  } catch (error) {
    return undefined;
  }
};

const getDropletAddress = async (): Promise<string | undefined> => getMeta("interfaces/public/0/anchor_ipv4/address");

export class Server {
  private readonly socket = dgram.createSocket("udp4");
  private readonly connections: Map<string, Connection> = new Map();
  private readonly redis: Redis.Redis;
  private readonly reservedCodes: Map<string, string> = new Map();
  private readonly codeCallbacks: Map<string, (connection: Connection) => void> = new Map([
    ["!!!!", (connection: Connection): void => {
      connection.sendReliable([new CancelJoinGamePacket("!!!!")]);
    }],
  ]);

  private readonly authHandler: AuthHandler;

  private connectionIndex = 0;
  private isFetching = false;
  private lobbyCache: Record<string, string>[] = [];
  private gamemodes: string[] = [];

  constructor(
    public readonly config: Config,
  ) {
    const redisPort = parseInt(process.env.NP_REDIS_PORT ?? "", 10);
    const port = parseInt(process.env.NP_DROPLET_PORT ?? "", 10);

    (SUPPORTED_VERSIONS as Mutable<ClientVersion[]>).push(new ClientVersion(2021, 4, 2));

    config.redis.host = process.env.NP_REDIS_HOST?.trim() ?? config.redis.host;
    config.redis.port = Number.isInteger(redisPort) ? redisPort : config.redis.port;
    config.redis.password = process.env.NP_REDIS_PASSWORD?.trim() ?? undefined;
    config.server.host = process.env.NP_DROPLET_BIND_ADDRESS?.trim() ?? config.server.host;
    config.server.port = Number.isInteger(port) ? port : config.server.port;
    config.server.publicIp = process.env.NP_DROPLET_ADDRESS?.trim() ?? config.server.publicIp;
    config.server.name = os.hostname();
    config.debug = process.env.NP_LOG_DEBUG?.trim() === "true";

    const enableAuthPackets = process.env.NP_DISABLE_AUTH?.trim() !== "true";

    this.socket.on("message", (buf, remoteInfo) => {
      const connection = this.getConnection(ConnectionInfo.fromString(`${remoteInfo.address}:${remoteInfo.port}`));
      let message = MessageReader.fromRawBytes(buf);

      if (enableAuthPackets) {
        message = this.authHandler.transformInboundPacket(connection, message);
      }

      connection.emit("message", message);
    });

    this.socket.on("message", (buf, remoteInfo) => {
      this.getConnection(ConnectionInfo.fromString(`${remoteInfo.address}:${remoteInfo.port}`)).emit("message", MessageReader.fromRawBytes(buf));
    });

    if (config.redis.host?.startsWith("rediss://")) {
      config.redis.host = config.redis.host.substr("rediss://".length);
      config.redis.tls = {};
      config.redis.connectTimeout = 30000;
    }

    this.redis = new Redis(config.redis);

    this.redis.once("connect", async () => {
      console.log(`Redis connected to ${config.redis.host}:${config.redis.port}`);

      this.gamemodes = await this.redis.smembers("loadpolus.config.gamemodes");

      for (let i = 0; i < this.gamemodes.length; i++) {
        const code = `[]${`${i}`.padStart(2, "0")}`;

        this.reservedCodes.set(this.gamemodes[i], code);
        this.codeCallbacks.set(code, this.createMatchmakingFunction(this.gamemodes[i]));
      }

      setInterval(this.updateGameCache.bind(this), 3000);
    });

    this.authHandler = new AuthHandler(process.env.NP_AUTH_TOKEN ?? "");

    this.socket.on("message", (buf, remoteInfo) => {
      const connection = this.getConnection(ConnectionInfo.fromString(`${remoteInfo.address}:${remoteInfo.port}`));
      const newMessageReader = this.authHandler.transformInboundPacket(connection, MessageReader.fromRawBytes(buf));

      connection.emit("message", newMessageReader);
    });
  }

  async listen(): Promise<void> {
    if (isInDocker()) {
      const anchor = await getDropletAddress();

      if (anchor !== undefined) {
        this.config.server.host = anchor;
      }
    }

    this.socket.bind(this.config.server.port, this.config.server.host, () => {
      console.log(`Server running on ${this.config.server.host}:${this.config.server.port}`);
    });
  }

  getConnection(connectionInfo: ConnectionInfo): Connection {
    const identifier = connectionInfo.toString();
    let connection = this.connections.get(identifier);

    if (connection) {
      return connection;
    }

    this.connections.set(
      identifier,
      connection = this.initializeConnection(connectionInfo),
    );

    return connection;
  }

  private handleMatchmaking(gamemode: string, connection: Connection): void {
    this.debugLog("handleMatchmaking() invoked", gamemode, connection);

    const results = this.lobbyCache.filter(game => {
      if (game.public !== "true") {
        return false;
      }

      if (game.gamemode !== gamemode) {
        return false;
      }

      if (parseInt(game.currentPlayers, 10) >= parseInt(game.maxPlayers, 10)) {
        return false;
      }

      if (game.gameState !== "NotStarted") {
        return false;
      }

      return true;
    });

    if (results.length < 1) {
      connection.disconnect(DisconnectReason.custom(`Could not find a public ${gamemode} lobby for you to join.\nWhy not host your own?`));

      return;
    }

    const lobby = results.sort((a, b) => parseInt(a.currentPlayers, 10) - parseInt(b.currentPlayers, 10))[results.length - 1];

    connection.sendReliable([
      new HostGameResponsePacket(lobby.code),
      new RedirectPacket(lobby.host, parseInt(lobby.port, 10)),
    ]);
  }

  private createMatchmakingFunction(gamemode: string): (connection: Connection) => void {
    return ((connection: Connection): void => {
      this.handleMatchmaking(gamemode, connection);
    }).bind(this);
  }

  private async updateGameCache(): Promise<void> {
    //this.debugLog("updateGameCache() invoked");

    if (this.isFetching) {
      this.debugLog("updateGameCache() cancelled due to this.isFetching");

      return;
    }

    this.isFetching = true;

    try {
      // Get all nodes
      const nodes = await this.redis.smembers("loadpolus.nodes");
      // Get all lobbies
      const listPipeline = this.redis.pipeline();
      const tempCache: Record<string, string>[] = [];
      const codes: string[] = [];

      for (let i = 0; i < nodes.length; i++) {
        const currentNode = nodes[i];

        listPipeline.smembers(`loadpolus.node.${currentNode}.lobbies`);
      }

      const listResults = await listPipeline.exec();

      for (let i = 0; i < listResults.length; i++) {
        const result = listResults[i];

        if (result[0] !== null) {
          continue;
        }

        codes.push(...(result[1] as string[]));
      }

      // Get every selected lobby
      const lobbyPipeline = this.redis.pipeline();

      for (let i = 0; i < codes.length; i++) {
        lobbyPipeline.hgetall(`loadpolus.lobby.${codes[i]}`);
      }

      const lobbyResults = await lobbyPipeline.exec();

      for (let i = 0; i < lobbyResults.length; i++) {
        const result = lobbyResults[i];

        if (result[0] !== null) {
          continue;
        }

        result[1].code = codes[i];

        tempCache.push(result[1]);
      }

      this.lobbyCache = tempCache;
    } finally {
      this.isFetching = false;
    }

    //this.debugLog("updateGameCache() results", this.lobbyCache);
  }

  private async fetchNodes(nodesKey: string = "loadpolus.nodes"): Promise<Map<string, Record<string, string>>> {
    let availableNodes: string[];

    try {
      availableNodes = await this.redis.smembers(nodesKey);
    } catch (error) {
      return Promise.reject(error);
    }

    const nodeData = new Map<string, Record<string, string>>();
    const nodePipeline = this.redis.pipeline();

    for (let i = 0; i < availableNodes.length; i++) {
      const node = availableNodes[i];

      nodePipeline.hgetall(`loadpolus.node.${node}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let nodeResults: [Error | null, any][];

    try {
      nodeResults = await nodePipeline.exec();
    } catch (error) {
      return Promise.reject(error);
    }

    for (let i = 0; i < nodeResults.length; i++) {
      const result = nodeResults[i];

      if (result[0] !== null) {
        continue;
      }

      nodeData.set(availableNodes[i], result[1]);
    }

    return nodeData;
  }

  private async handlePacket(packet: BaseRootPacket, sender: Connection): Promise<void> {
    this.debugLog("handlePacket() invoked", packet, sender);

    switch (packet.getType()) {
      case RootPacketType.HostGame: {
        if (this.redis.status != "ready") {
          sender.disconnect(DisconnectReason.custom("An error occured while creating your game, and the developers have been notified.\n\nPlease try again."));
          console.error("Kicked", sender.getConnectionInfo().toString(), "because redis.status != ready! Make sure Redis is available.");

          return;
        }

        this.debugLog("got to HostGame");

        const userData = sender.getMeta<UserResponseStructure>("pgg.auth.self");
        let nodeData: Map<string, Record<string, string>>;

        // TODO: allow option to toggle which server you get sent to

        if (userData.perks.includes("server.access.creator")) {
          nodeData = await this.fetchNodes("loadpolus.nodes.creator");
        } else {
          nodeData = await this.fetchNodes();
        }

        this.debugLog("available nodes:", nodeData);

        let best: string | undefined;

        for (const node of nodeData) {
          if (node[1].maintenance === "true") {
            this.debugLog("skip node due to maintenance", node);

            continue;
          }

          const players = parseInt(node[1].currentConnections, 10);

          if (players >= parseInt(node[1].maxConnections, 10)) {
            this.debugLog("skip node due to full", node);

            continue;
          }

          if (best === undefined) {
            this.debugLog("bump node to first as only", node);
            best = node[0];

            continue;
          }

          if (players < parseInt(nodeData.get(best!)!.currentConnections, 10)) {
            this.debugLog("bump new node to first as lower player count", node);
            best = node[0];
          }
        }

        if (best === undefined) {
          console.error("Kicked", sender.getConnectionInfo().toString(), "because no servers are available!");
          sender.disconnect(DisconnectReason.custom("There are no servers currently available.\n\nPlease try again later."));

          return;
        }

        const bestData = nodeData.get(best)!;

        sender.sendReliable([new RedirectPacket(bestData.host, parseInt(bestData.port, 10))]);
        console.log("Redirected", sender.getConnectionInfo().toString(), "to node", bestData.host, "to host game");

        //this.debugLog("sent player to node bestData", bestData);
        break;
      }
      case RootPacketType.JoinGame: {
        if (this.redis.status != "ready") {
          sender.disconnect(DisconnectReason.custom("An error occured while joining the game, and the developers have been notified.\n\nPlease try again."));
          console.error("Kicked", sender.getConnectionInfo().toString(), "because redis.status != ready! Make sure Redis is available.");

          return;
        }

        const joinedGamePacket = packet as JoinedGamePacket;
        const callback = this.codeCallbacks.get(joinedGamePacket.lobbyCode);

        if (callback !== undefined) {
          callback(sender);

          return;
        }

        const lobbyData = await this.redis.hgetall(`loadpolus.lobby.${joinedGamePacket.lobbyCode}`);

        if (Object.keys(lobbyData).length < 1) {
          console.log("Kicked", sender.getConnectionInfo().toString(), "trying to join non-existent lobby", joinedGamePacket.lobbyCode);
          sender.disconnect(DisconnectReason.gameNotFound());

          return;
        }

        if (lobbyData.creator === "true") {
          if (sender.getMeta<UserResponseStructure>("pgg.auth.self").perks.indexOf("server.access.creator") < 0) {
            console.log("Kicked", sender.getConnectionInfo().toString(), "trying to join restricted creator lobby", joinedGamePacket.lobbyCode);
            sender.disconnect(DisconnectReason.gameNotFound());

            return;
          }
        }

        sender.sendReliable([new RedirectPacket(
          lobbyData.host,
          parseInt(lobbyData.port, 10),
        )]);
        console.log("Redirected", sender.getConnectionInfo().toString(), "to", lobbyData.host, "to join game", joinedGamePacket.lobbyCode);
        break;
      }
      case RootPacketType.GetGameList: {
        this.debugLog("got GetGameList");

        if (this.redis.status != "ready") {
          sender.disconnect(DisconnectReason.custom("An error occured while searching for games, and the developers have been notified.\n\nPlease try again."));
          this.debugLog("drop player due to this.redis.status");

          return;
        }

        const listings: LobbyListing[] = new Array(this.gamemodes.length + 1);

        for (let i = 0; i < listings.length; i++) {
          if (i == 0) {
            listings[i] = this.makeListing("!!!!", "[ Gamemodes ]");

            continue;
          }

          const gamemode = this.gamemodes[i - 1];

          listings[i] = this.makeListing(this.reservedCodes.get(gamemode)!, gamemode);
        }

        this.debugLog("sent listings", listings);

        sender.sendReliable([new GetGameListResponsePacket(listings)]);
        break;
      }
      default: {
        break;
      }
    }
  }

  private getNextConnectionId(): number {
    if (++this.connectionIndex > MaxValue.UInt32) {
      this.connectionIndex = 0;
    }

    return this.connectionIndex;
  }

  private initializeConnection(connectionInfo: ConnectionInfo): Connection {
    console.log("Connection with", connectionInfo.toString(), "established");

    const newConnection = new Connection(connectionInfo, this.socket, PacketDestination.Client);

    newConnection.setId(this.getNextConnectionId());

    newConnection.on("packet", async (packet: BaseRootPacket) => {
      try {
        await this.handlePacket(packet, newConnection);
      } catch (error) {
        newConnection.disconnect(DisconnectReason.custom("A server error occurred, and the developers have been notified.\n\nPlease try again."));
        console.error("Error while handling packet", packet, connectionInfo.toString(), error);
      }
    });

    newConnection.once("disconnected").then(() => {
      this.handleDisconnect(newConnection);
    });

    return newConnection;
  }

  private handleDisconnect(connection: Connection): void {
    console.log("Connection with", connection.getConnectionInfo().toString(), "lost");
    this.connections.delete(connection.getConnectionInfo().toString().toString());
  }

  private makeListing(code: string, name: string | TextComponent): LobbyListing {
    return new LobbyListing(
      this.config.server.publicIp,
      this.config.server.port,
      code,
      name.toString(),
      0,
      0,
      Level.Polus,
      0,
      0,
    );
  }

  private debugLog(...args: unknown[]): void {
    if (this.config.debug) {
      console.log(...args);
    }
  }
}
