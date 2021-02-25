import { Level, PacketDestination, RootPacketType } from "nodepolus/lib/types/enums";
import { ConnectionInfo, DisconnectReason, LobbyListing } from "nodepolus/lib/types";
import { MessageReader } from "nodepolus/lib/util/hazelMessage";
import { Connection } from "nodepolus/lib/protocol/connection";
import { CancelJoinGamePacket } from "./cancelJoinGamePacket";
import { MaxValue } from "nodepolus/lib/util/constants";
import { TextComponent } from "nodepolus/lib/api/text";
import { Config } from "./config";
import Redis from "ioredis";
import dgram from "dgram";
import {
  BaseRootPacket,
  GetGameListResponsePacket,
  HostGameResponsePacket,
  JoinedGamePacket,
  RedirectPacket,
} from "nodepolus/lib/protocol/packets/root";

export class Server {
  private readonly socket = dgram.createSocket("udp4");
  private readonly connections: Map<string, Connection> = new Map();
  private readonly redis: Redis.Redis;
  private readonly gamemodes: string[];
  private readonly reservedCodes: Map<string, string> = new Map();
  private readonly codeCallbacks: Map<string, (connection: Connection) => void> = new Map([
    ["!!!!", (connection: Connection): void => {
      connection.writeReliable(new CancelJoinGamePacket("!!!!"));
    }],
    ["AMOGUS", (connection: Connection): void => connection.disconnect(DisconnectReason.custom("lookin real sussy"))]
  ]);

  private connectionIndex = 0;
  private isFetching = false;
  private lobbyCache: Record<string, string>[] = [];

  constructor(
    public readonly config: Config,
  ) {
    this.socket.on("message", (buf, remoteInfo) => {
      this.getConnection(ConnectionInfo.fromString(`${remoteInfo.address}:${remoteInfo.port}`)).emit("message", new MessageReader(buf));
    });

    this.redis = new Redis(config.redis);
    this.gamemodes = ["foo", "bar", ""];

    for (let i = 0; i < this.gamemodes.length; i++) {
      const code = `[]${`${i}`.padStart(2, "0")}`;

      this.reservedCodes.set(this.gamemodes[i], code);
      this.codeCallbacks.set(code, this.createMatchmakingFunction(this.gamemodes[i]));
    }

    setInterval(this.updateGameCache.bind(this), 3000);
  }

  listen(): void {
    this.socket.bind(this.config.server.port, this.config.server.host, () => {
      console.log(`Server running on ${this.config.server.host}:${this.config.server.port}`);
    });
  }

  getConnection(connectionInfo: string | ConnectionInfo): Connection {
    let info: ConnectionInfo;
    let identifier: string;

    if (typeof connectionInfo != "string") {
      info = connectionInfo;
      identifier = info.toString();
    } else {
      info = ConnectionInfo.fromString(connectionInfo);
      identifier = connectionInfo;
    }

    let connection = this.connections.get(identifier);

    if (connection) {
      return connection;
    }

    connection = this.initializeConnection(info);

    this.connections.set(identifier, connection);

    return connection;
  }

  private handleMatchmaking(gamemode: string, connection: Connection): void {
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
      connection.disconnect(DisconnectReason.custom(
        `Could not find a public ${gamemode} game for you to join.\nWhy not host your own game?`,
      ));

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
    if (this.isFetching) {
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
  }

  private async fetchNodes(): Promise<Map<string, Record<string, string>>> {
    let availableNodes: string[];
    
    try {
      availableNodes = await this.redis.smembers("loadpolus.nodes");
    } catch (e) {
      return Promise.reject(e);
    }

    const nodeData = new Map<string, Record<string, string>>();
    const nodePipeline = this.redis.pipeline();

    for (let i = 0; i < availableNodes.length; i++) {
      const node = availableNodes[i];

      nodePipeline.hgetall(`loadpolus.node.${node}`);
    }

    let nodeResults: [Error | null, any][];

    try {
      nodeResults = await nodePipeline.exec();
    } catch (e) {
      return Promise.reject(e);
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
    switch (packet.getType()) {
      case RootPacketType.HostGame: {
        if (this.redis.status != "ready") {
          sender.disconnect(DisconnectReason.custom("Error while hosting game: Redis is offline. Please try again later.\nIf this error persists, contact polus.gg staff."));
          return;
        }

        const nodeData = await this.fetchNodes();

        let best: string | undefined;

        for (const node of nodeData) {
          if (node[1].maintenance === "true") {
            continue;
          }

          const players = parseInt(node[1].currentConnections, 10);

          if (players >= parseInt(node[1].maxConnections, 10)) {
            continue;
          }

          if (best === undefined) {
            best = node[0];

            continue;
          }

          if (players < parseInt(nodeData.get(best!)!.currentConnections, 10)) {
            best = node[0];
          }
        }

        if (best === undefined) {
          sender.disconnect(DisconnectReason.custom("There are no servers currently available. Please try again later."));

          return;
        }

        const bestData = nodeData.get(best)!;

        console.log("Connection ID", sender.id, "hosting game on server", bestData.host);

        sender.sendReliable([new RedirectPacket(
          bestData.host,
          parseInt(bestData.port, 10),
        )]);
        break;
      }
      case RootPacketType.JoinGame: {
        if (this.redis.status != "ready") {
          sender.disconnect(DisconnectReason.custom("Error while joining game: Redis is offline. Please try again later.\nIf this error persists, contact polus.gg staff."));
          return;
        }

        const joinedGamePacket = packet as JoinedGamePacket;
        const callback = this.codeCallbacks.get(joinedGamePacket.lobbyCode);

        if (callback !== undefined) {
          console.log("Connection ID", sender.id, "joining game", joinedGamePacket.lobbyCode, "handled by callback")
          callback(sender);

          return;
        }

        const lobbyData = await this.redis.hgetall(`loadpolus.lobby.${joinedGamePacket.lobbyCode}`);

        if (Object.keys(lobbyData).length < 1) {
          sender.disconnect(DisconnectReason.gameNotFound());
          console.log("Connection ID", sender.id, "joining non-existent game", joinedGamePacket.lobbyCode);

          return;
        }

        console.log("Connection ID", sender.id, "joining game", joinedGamePacket.lobbyCode, "on server", lobbyData.host);

        sender.sendReliable([new RedirectPacket(
          lobbyData.host,
          parseInt(lobbyData.port, 10),
        )]);
        break;
      }
      case RootPacketType.GetGameList: {
        if (this.redis.status != "ready") {
          sender.disconnect(DisconnectReason.custom("Error while fetching games: Redis is offline. Please try again later.\nIf this error persists, contact polus.gg staff."));
          return;
        }

        const listings: LobbyListing[] = new Array(this.gamemodes.length + 1);

        for (let i = 0; i < listings.length; i++) {
          if (i == 0) {
            listings[i] = this.makeListing("!!!!", new TextComponent().add("[ Public ]").toString());

            continue;
          }

          const gamemode = this.gamemodes[i - 1];

          listings[i] = this.makeListing(this.reservedCodes.get(gamemode)!, gamemode);
        }

        sender.writeReliable(new GetGameListResponsePacket(listings));
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
    const newConnection = new Connection(connectionInfo, this.socket, PacketDestination.Client);

    newConnection.id = this.getNextConnectionId();

    console.log("Accepted connection ID", newConnection.id, "from address", connectionInfo.toString())

    newConnection.on("packet", async (packet: BaseRootPacket) => {
      try {
        await this.handlePacket(packet, newConnection);
      } catch (e) {
        console.log("Unhandled error in packet handler:", e);
        newConnection.disconnect(DisconnectReason.custom(`An unhandled error occurred! Please report this to a polus.gg dev.\nDetails: ${e}`));
      }
    });

    newConnection.once("disconnected").then(() => {
      this.handleDisconnect(newConnection);
    });

    return newConnection;
  }

  private handleDisconnect(connection: Connection): void {
    console.log("Connection ID", connection.id, "disconnected");
    this.connections.delete(connection.getConnectionInfo().toString());
  }

  private makeListing(code: string, name: string | TextComponent): LobbyListing {
    return new LobbyListing(
      this.config.server.publicIp,
      this.config.server.port,
      code,
      name.toString(),
      0,
      0,
      Level.TheSkeld,
      0,
      0,
    );
  }
}
