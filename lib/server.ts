import dgram from "dgram";
import redis, { RedisClient } from "redis";
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
  private readonly redisClient: RedisClient;

  private connectionIndex = 0;

  constructor(public readonly config: Config) {
    this.serverSocket.on("message", (buf, remoteInfo) => {
      this.getConnection(ConnectionInfo.fromString(`${remoteInfo.address}:${remoteInfo.port}`)).emit("message", new MessageReader(buf));
    });

    this.redisClient = redis.createClient(this.config.redis);

    if (!this.redisClient.ping()) {
      throw new Error("Failed to connect to Redis!");
    }
  }

  listen(): void {
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

  private handlePacket(packet: BaseRootPacket, _sender: Connection): void {
    console.log(BaseRootPacket);

    switch (packet.type) {
      case RootPacketType.HostGame: {
        break;
      }
      case RootPacketType.JoinGame: {
        const joinedGamePacket = packet as JoinedGamePacket;

        this.redisClient.hmget(scope("loadpolus", "lobby", joinedGamePacket.lobbyCode));
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

    newConnection.on("packet", (packet: BaseRootPacket) => {
      if (!packet.isCancelled) {
        this.handlePacket(packet, newConnection);
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
