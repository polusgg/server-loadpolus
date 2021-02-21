import { BaseRootPacket, GetGameListResponsePacket, HostGameResponsePacket, JoinedGamePacket, JoinGameErrorPacket, RedirectPacket } from "nodepolus/lib/protocol/packets/root";
import { PacketDestination, RootPacketType } from "nodepolus/lib/protocol/packets/types/enums";
import { ConnectionInfo, DisconnectReason } from "nodepolus/lib/types";
import { MessageReader } from "nodepolus/lib/util/hazelMessage";
import { Connection } from "nodepolus/lib/protocol/connection";
import { MaxValue } from "nodepolus/lib/util/constants";
import { Config } from "./config";
import Redis from "ioredis";
import dgram from "dgram";
import { LobbyListing } from "nodepolus/lib/protocol/packets/root/types";
import { Level } from "nodepolus/lib/types/enums";
import { CancelJoinGamePacket } from "./cancelJoinGamePacket";
import { TextComponent } from "nodepolus/lib/api/text";

export class Server {
  private readonly socket = dgram.createSocket("udp4");
  private readonly connections: Map<string, Connection> = new Map();
  private readonly redis: Redis.Redis;
  private readonly gamemodes: string[];
  private readonly gamemodeReservedCodes: Map<string, string> = new Map();
  private readonly gamecodeCallbacks: Map<string, (connection: Connection) => void> = new Map([
    // eslint-disable-next-line @typescript-eslint/require-await
    ["!!!!", async (connection: Connection): Promise<void> => {
      connection.writeReliable(new CancelJoinGamePacket("!!!!"));
    }],
  ]);

  private connectionIndex = 0;
  private isFetching = false;
  private gameCache: Record<string, string>[] = [];

  constructor(public readonly config: Config) {
    this.socket.on("message", (buf, remoteInfo) => {
      this.getConnection(ConnectionInfo.fromString(`${remoteInfo.address}:${remoteInfo.port}`)).emit("message", new MessageReader(buf));
    });

    this.redis = new Redis(config.redis);
    this.gamemodes = ["foo", "bar", ""];

    for (let i = 0; i < this.gamemodes.length; i++) {
      const code = `[]${`${i}`.padStart(2, "0")}`;

      this.gamemodeReservedCodes.set(this.gamemodes[i], code);

      this.gamecodeCallbacks.set(code, this.createMatchmakingFunction(this.gamemodes[i]));
    }

    console.log("Gamemode code mappings:", this.gamemodeReservedCodes);

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
    console.log(gamemode);

    // try to find a game
    let results = this.gameCache.filter(game => (game.public === "true"));

    // this doesn't deal with map/impostor/language filtering
    results = results.filter(game => game.gamemode == gamemode);
    results = results.filter(game => parseInt(game.currentPlayers, 10) < parseInt(game.maxPlayers, 10));
    results = results.filter(game => game.gameState == "NotStarted");

    if (results.length < 1) {
      connection.writeReliable(new JoinGameErrorPacket(DisconnectReason.custom(
        `Could not find a public ${gamemode} game for you to join.\nWhy not host your own game?`,
      )));

      return;
    }

    results = results.sort((a, b) => parseInt(a.currentPlayers, 10) - parseInt(b.currentPlayers, 10));

    const targetGame = results[results.length - 1];

    connection.sendReliable([
      new HostGameResponsePacket(targetGame.code),
      new RedirectPacket(targetGame.host, parseInt(targetGame.port, 10)),
    ]);
  }

  private createMatchmakingFunction(gm: string): (connection: Connection) => void {
    return ((connection: Connection): void => {
      // capture gamemode
      const gamemode = gm;

      this.handleMatchmaking(gamemode, connection);
    }).bind(this);
  }

  private async updateGameCache(): Promise<void> {
    // this is a expensive operation, possibly requiring thousands of redis calls

    if (this.isFetching) {
      return;
    }

    this.isFetching = true;

    try {
      const tempGameCache: Record<string, string>[] = [];

      // get nodes
      const nodes = await this.redis.smembers("loadpolus.nodes");

      // get all games on the network using a pipeline
      const gameListPipeline = this.redis.pipeline();
      let gameCodes: string[] = [];

      for (let i = 0; i < nodes.length; i++) {
        const currentNode = nodes[i];

        gameListPipeline.smembers(`loadpolus.node.${currentNode}.games`);
      }

      const gameListPipelineResults = await gameListPipeline.exec();

      for (let i = 0; i < gameListPipelineResults.length; i++) {
        const pipelineResult = gameListPipelineResults[i];

        if (pipelineResult[0] !== null) {
          // error while fetching these games
          continue;
        }

        const gamesForNode = pipelineResult[1] as string[];

        for (let j = 0; j < gamesForNode.length; j++) {
          gameCodes = Array.prototype.concat(gameCodes, gamesForNode);
        }
      }

      // get all data for all games using a second pipeline
      const gameDataPipeline = this.redis.pipeline();

      for (let i = 0; i < gameCodes.length; i++) {
        gameDataPipeline.hgetall(`loadpolus.lobby.${gameCodes[i]}`);
      }

      const gameDataPipelineResults = await gameDataPipeline.exec();

      for (let i = 0; i < gameDataPipelineResults.length; i++) {
        const pipelineResult = gameDataPipelineResults[i];

        if (pipelineResult[0] !== null) {
          // error while fetching this game
          continue;
        }

        pipelineResult[1].code = gameCodes[i];

        tempGameCache.push(pipelineResult[1]);
      }

      this.gameCache = tempGameCache;
    } finally {
      this.isFetching = false;
    }
  }

  private async fetchNodes(): Promise<Map<string, Record<string, string>>> {
    const availableNodes = await this.redis.smembers("loadpolus.nodes");
    const nodeData = new Map<string, Record<string, string>>();
    const nodeFetchPipeline = this.redis.pipeline();

    for (let i = 0; i < availableNodes.length; i++) {
      const node = availableNodes[i];

      nodeFetchPipeline.hgetall(`loadpolus.node.${node}`);
    }

    const results = await nodeFetchPipeline.exec();

    for (let i = 0; i < results.length; i++) {
      nodeData.set(availableNodes[i], results[i][1]);
    }

    return nodeData;
  }

  private async handlePacket(packet: BaseRootPacket, sender: Connection): Promise<void> {
    switch (packet.type) {
      case RootPacketType.HostGame: {
        const nodeData = await this.fetchNodes();
        let best: string | undefined;

        for (const node of nodeData) {
          if (node[1].maintenance === "true") {
            continue;
          }

          const currentNodePlayerCount = parseInt(node[1].currentConnections, 10);

          if (currentNodePlayerCount >= parseInt(node[1].maxConnections, 10)) {
            // ignore full nodes
            continue;
          }

          if (best === undefined) {
            // we have made it past all the prev checks without getting a node
            // node[0] is good, use it for further comparisons
            // this is placed here because the next operation required nodeData.get(best)
            best = node[0];
            continue;
          }

          if (currentNodePlayerCount < parseInt(nodeData.get(best!)!.currentConnections, 10)) {
            best = node[0];
          }
        }

        if (best === undefined) {
          sender.sendReliable([new JoinGameErrorPacket(DisconnectReason.custom(
            "There are no servers currently available. Please try again later.",
          ))]);

          return;
        }

        const bestData = nodeData.get(best)!;

        sender.sendReliable([new RedirectPacket(
          bestData.host,
          parseInt(bestData.port, 10),
        )]);

        break;
      }
      case RootPacketType.JoinGame: {
        const joinedGamePacket = packet as JoinedGamePacket;

        if (this.gamecodeCallbacks.has(joinedGamePacket.lobbyCode)) {
          this.gamecodeCallbacks.get(joinedGamePacket.lobbyCode)!(sender);

          return;
        }

        const lobbyData = await this.redis.hgetall(`loadpolus.lobby.${joinedGamePacket.lobbyCode}`);

        if (Object.keys(lobbyData).length < 1) {
          sender.sendReliable([new JoinGameErrorPacket(DisconnectReason.gameNotFound())]);

          return;
        }

        sender.sendReliable([new RedirectPacket(
          lobbyData.host,
          parseInt(lobbyData.port, 10),
        )]);

        break;
      }
      case RootPacketType.GetGameList: {
        // layout looks like this:
        /*
         * [ Public ]
         * gamemodes here
         */

        const listings: LobbyListing[] = new Array(this.gamemodes.length + 1);
        //const nodeData = await this.fetchNodes();
        //const values = [...nodeData.values()];

        for (let i = 0; i < listings.length; i++) {
          if (i == 0) {
            // write [ Public ] header
            listings[i] = this.makeListing("!!!!", new TextComponent().add("[ Public ]").toString());

            continue;
          }

          const currentGamemode = this.gamemodes[i - 1];
          //const randomNode = values[Math.floor(Math.random() * values.length)];

          listings[i] = this.makeListing(this.gamemodeReservedCodes.get(currentGamemode)!, currentGamemode);

          /*new LobbyListing(
            randomNode.host,
            parseInt(randomNode.port, 10),
            this.gamemodeReservedCodes.get(currentGamemode)!,
            currentGamemode,
            0,
            0,
            Level.TheSkeld,
            0,
            0,
          );*/
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

    //console.log("Initialized connection", newConnection.id);

    newConnection.on("packet", async (packet: BaseRootPacket) => {
      if (!packet.isCancelled) {
        await this.handlePacket(packet, newConnection);
      }
    });

    newConnection.once("disconnected").then(() => {
      this.handleDisconnect(newConnection);
    });

    return newConnection;
  }

  private handleDisconnect(connection: Connection): void {
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
