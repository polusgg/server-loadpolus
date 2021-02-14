import dgram from "dgram";
import Redis from "ioredis";
import { Connection } from "nodepolus/lib/protocol/connection";
import { BaseRootPacket, JoinedGamePacket } from "nodepolus/lib/protocol/packets/root";
import { PacketDestination, RootPacketType } from "nodepolus/lib/protocol/packets/types/enums";
import { ConnectionInfo } from "nodepolus/lib/types";
import { MaxValue } from "nodepolus/lib/util/constants";
import { MessageReader } from "nodepolus/lib/util/hazelMessage";
import { Config } from "..";
import { scope } from "./util/scopes";

export class Server {
  private readonly serverSocket = dgram.createSocket("udp4");
  private readonly connections: Map<string, Connection> = new Map();
  private readonly redisClient: Redis.Redis;

  private connectionIndex = 0;

  constructor(public readonly config: Config) {
    this.serverSocket.on("message", (buf, remoteInfo) => {
      this.getConnection(ConnectionInfo.fromString(`${remoteInfo.address}:${remoteInfo.port}`)).emit("message", new MessageReader(buf));
    });

    this.redisClient = new Redis({
      port: 6379,
      host: "127.0.0.1",
      family: 4,
      password: "auth",
      db: 0,
    });

    this.redisClient.connect();
  }

  listen(): void {
    console.log(`Server running on ${this.config.server.host}:${this.config.server.port}`);
    this.serverSocket.bind(this.config.server.port, this.config.server.host);
  }

  /**
   * @stolen NodePolus
   * @author <@codyphobe>
   */
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

  /**
   * @stolen NodePolus
   * @author <@codyphobe>
   */
  private getNextConnectionId(): number {
    if (++this.connectionIndex > MaxValue.UInt32) {
      this.connectionIndex = 0;
    }

    return this.connectionIndex;
  }

  private async handlePacket(packet: BaseRootPacket, _sender: Connection): Promise<void> {
    console.log(packet);

    switch (packet.type) {
      case RootPacketType.HostGame: {
        break;
      }
      case RootPacketType.JoinGame: {
        const joinedGamePacket = packet as JoinedGamePacket;

        let lobbyData = await this.redisClient.hmget(scope("loadpolus", "lobby", joinedGamePacket.lobbyCode));

        this.redisClient.hmset("key", "value", "key2", "value2");

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

  /**
   * @stolen NodePolus
   * @author <@codyphobe>
   */
  private initializeConnection(connectionInfo: ConnectionInfo): Connection {
    const newConnection = new Connection(connectionInfo, this.serverSocket, PacketDestination.Client);

    newConnection.id = this.getNextConnectionId();

    console.log("Initialized connection", newConnection.id);

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

  /**
   * @stolen NodePolus
   * @author <@codyphobe>
   */
  private handleDisconnect(connection: Connection): void {
    this.connections.delete(connection.getConnectionInfo().toString());
  }
}
