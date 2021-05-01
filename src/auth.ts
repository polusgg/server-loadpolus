import { UserResponseStructure } from "@polusgg/module-polusgg-auth-api/src/types/userResponseStructure";
import { Requester } from "@polusgg/module-polusgg-auth-api/src/requester/requester";
import { MessageReader } from "@nodepolus/framework/src/util/hazelMessage";
import { Connection } from "@nodepolus/framework/src/protocol/connection";
import { DisconnectReason } from "@nodepolus/framework/src/types";
import { Hmac } from "@nodepolus/framework/src/util/hmac";

/*
type PolusAuthConfig = {
  token: string;
};
*/

export class AuthHandler {
  private readonly requester: Requester;

  constructor(authToken: string) {
    this.requester = new Requester("https://account.polus.gg");
    this.requester.setAuthenticationToken(authToken);
  }

  transformInboundPacket(connection: Connection, packet: MessageReader): MessageReader {
    const tag = packet.peek(0);

    if (tag == 9) {
      // ignore disconnect packets, roobscoob sux
      return packet;
    }

    if (packet.readByte() !== 0x80) {
      console.warn("Connection %s attempted send an unauthenticated packet", connection.getConnectionInfo().toString());
      connection.disconnect(DisconnectReason.custom("Authentication Error - Unauthenticated packet."));

      return MessageReader.fromRawBytes([0x00]);
    }

    //1 byte for authentication magic (0x80)
    //16 bytes for client UUID
    //20 bytes for SHA1 HMAC

    if (packet.getLength() < 1 + 16 + 20) {
      console.warn("Connection %s attempted send an invalid authentication packet. It was too short.", connection);
      connection.disconnect(DisconnectReason.custom("Authentication Error - Packet too short."));

      return MessageReader.fromRawBytes([0x00]);
    }

    if (packet.getLength() <= 1 + 16 + 20) {
      console.warn("Connection %s attempted send an invalid authentication packet. It was empty.", connection);
      connection.disconnect(DisconnectReason.custom("Authentication Error - Empty packet."));

      return MessageReader.fromRawBytes([0x00]);
    }

    const uuid = `${packet.readBytes(4).getBuffer().toString("hex")}-${packet.readBytes(2).getBuffer().toString("hex")}-${packet.readBytes(2).getBuffer().toString("hex")}-${packet.readBytes(2).getBuffer().toString("hex")}-${packet.readBytes(6).getBuffer().toString("hex")}`;
    const hmacResult = packet.readBytes(20);
    const remaining = packet.readRemainingBytes();

    if (connection.getMeta<UserResponseStructure | undefined>("pgg.auth.self") !== undefined) {
      const user = connection.getMeta<UserResponseStructure>("pgg.auth.self");

      const ok = Hmac.verify(remaining.getBuffer(), hmacResult.getBuffer().toString("hex"), user.client_token);

      if (!ok) {
        console.warn("Connection %s attempted send an invalid authentication packet. Their HMAC verify failed.", connection.getConnectionInfo().toString());
        connection.disconnect(DisconnectReason.custom("Authentication Error - Invalid HMAC."));

        return MessageReader.fromRawBytes([0x00]);
      }

      return remaining;
    }

    // cache miss

    this.fetchAndCacheUser(uuid, connection)
      .then(user => {
        const ok = Hmac.verify(remaining.getBuffer(), hmacResult.getBuffer().toString("hex"), user.client_token);

        if (!ok) {
          console.warn("Connection %s attempted send an invalid authentication packet. Their HMAC verify failed.", connection.getConnectionInfo().toString());
          connection.disconnect(DisconnectReason.custom("Authentication Error - Invalid HMAC (from fetchAndCacheUser)."));

          return;
        }

        connection.emit("message", remaining);
      })
      .catch(err => {
        console.warn("Connection %s attempted send an invalid authentication packet. The API did not return a valid result (%s).", connection.getConnectionInfo().toString(), err);
        connection.disconnect(DisconnectReason.custom("Authentication Error - Invalid API response."));
      });

    return MessageReader.fromRawBytes([0x00]);
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
