import { UserResponseStructure } from "@polusgg/module-polusgg-auth-api/src/types/userResponseStructure";
import { Requester } from "@polusgg/module-polusgg-auth-api/src/requester/requester";
import { MessageReader } from "@nodepolus/framework/src/util/hazelMessage";
import { Connection } from "@nodepolus/framework/src/protocol/connection";
import { DisconnectReason } from "@nodepolus/framework/src/types";
import { Hmac } from "@nodepolus/framework/src/util/hmac";

const TAG_AUTH = 0x80 as const;
const LENGTH_UUID = 16 as const;
const LENGTH_HASH = 20 as const;
const LENGTH_AUTH_HEADER = 1 + LENGTH_UUID + LENGTH_HASH;

export class AuthHandler {
  private readonly requester: Requester;

  constructor(authToken: string) {
    this.requester = new Requester("https://account.polus.gg");

    this.requester.setAuthenticationToken(authToken);
  }

  transformInboundPacket(connection: Connection, packet: MessageReader): MessageReader {
    // Ignore disconnect packets
    if (packet.peek(0) == 9) {
      return packet;
    }

    if (packet.readByte() !== TAG_AUTH) {
      console.warn(`Connection ${connection.getConnectionInfo().toString()} sent an unauthenticated packet`);
      connection.disconnect(DisconnectReason.custom("Authentication error: unauthenticated packet"));

      return new MessageReader();
    }

    if (packet.getLength() < LENGTH_AUTH_HEADER) {
      console.warn(`Connection ${connection.getConnectionInfo().toString()} sent an authenticated packet that was too short`);
      connection.disconnect(DisconnectReason.custom("Authentication error: packet too short"));

      return new MessageReader();
    }

    if (packet.getLength() === LENGTH_AUTH_HEADER) {
      console.warn(`Connection ${connection.getConnectionInfo().toString()} sent an authenticated packet that was empty`);
      connection.disconnect(DisconnectReason.custom("Authentication error: empty packet"));

      return new MessageReader();
    }

    const uuid = `${packet.readBytesAsString(4, "hex")}-${packet.readBytesAsString(2, "hex")}-${packet.readBytesAsString(2, "hex")}-${packet.readBytesAsString(2, "hex")}-${packet.readBytesAsString(6, "hex")}`;
    const signature = packet.readBytes(20);
    const message = packet.readRemainingBytes();

    if (connection.getMeta<UserResponseStructure | undefined>("pgg.auth.self") !== undefined) {
      const user = connection.getMeta<UserResponseStructure>("pgg.auth.self");

      if (!Hmac.verify(message.getBuffer(), signature.getBuffer().toString("hex"), user.client_token)) {
        console.warn(`Connection ${connection.getConnectionInfo().toString()} sent an authenticated packet with a mismatching signature (cached)`);
        connection.disconnect(DisconnectReason.custom("Authentication error: signature mismatch (cached)"));

        return new MessageReader();
      }

      return message;
    }

    // Cache miss
    this.fetchAndCacheUser(uuid, connection)
      .then(user => {
        if (!Hmac.verify(message.getBuffer(), signature.getBuffer().toString("hex"), user.client_token)) {
          console.warn(`Connection ${connection.getConnectionInfo().toString()} sent an authenticated packet with a mismatching signature`);
          connection.disconnect(DisconnectReason.custom("Authentication error: signature mismatch"));

          return;
        }

        connection.emit("message", message);
      })
      .catch(err => {
        console.warn(`Connection ${connection.getConnectionInfo().toString()} sent an authenticated packet which received an invalid API response:`, err);
        connection.disconnect(DisconnectReason.custom("Authentication error: invalid auth server response"));
      });

    return new MessageReader();
  }

  private async fetchAndCacheUser(uuid: string, connection: Connection): Promise<UserResponseStructure> {
    return new Promise((resolve, reject) => {
      this.requester.getUser(uuid).then(user => {
        connection.setMeta("pgg.auth.self", user);

        resolve(user);
      }).catch(reject);
    });
  }
}
