import { BaseRootPacket, JoinedGamePacket, JoinGameErrorPacket, RedirectPacket } from "nodepolus/lib/protocol/packets/root";
import { PacketDestination, RootPacketType } from "nodepolus/lib/protocol/packets/types/enums";
import { ConnectionInfo, DisconnectReason } from "nodepolus/lib/types";
import { MessageReader } from "nodepolus/lib/util/hazelMessage";
import { Connection } from "nodepolus/lib/protocol/connection";
import { MaxValue } from "nodepolus/lib/util/constants";
import { Config } from "./config";
import Redis from "ioredis";
import dgram from "dgram";

export class Server {
  private readonly socket = dgram.createSocket("udp4");
  private readonly connections: Map<string, Connection> = new Map();
  private readonly redis: Redis.Redis;

  private connectionIndex = 0;

  constructor(public readonly config: Config) {
    this.socket.on("message", (buf, remoteInfo) => {
      this.getConnection(ConnectionInfo.fromString(`${remoteInfo.address}:${remoteInfo.port}`)).emit("message", new MessageReader(buf));
    });

    this.redis = new Redis({
      port: 6379,
      host: "127.0.0.1",
    });
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

  private async handlePacket(packet: BaseRootPacket, sender: Connection): Promise<void> {
    switch (packet.type) {
      case RootPacketType.HostGame: {
        const availableNodes = await this.redis.smembers("loadpolus.nodes");
        const nodeData = new Map<string, Record<string, string>>();

        for (let i = 0; i < availableNodes.length; i++) {
          const node = availableNodes[i];

          nodeData.set(node, await this.redis.hgetall(`loadpolus.node.${node}`));
        }

        let best: string | undefined;

        for (const node of nodeData) {
          if (best === undefined) {
            best = node[0];

            continue;
          }

          if (node[1].maintenance === "true") {
            return;
          }

          const currentNodePlayerCount = parseInt(node[1].currentConnections, 10);

          if (currentNodePlayerCount >= parseInt(node[1].maxConnections, 10)) {
            return;
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
}
