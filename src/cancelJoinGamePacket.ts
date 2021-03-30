import { BaseRootPacket } from "@nodepolus/framework/src/protocol/packets/root";
import { RootPacketType } from "@nodepolus/framework/src/types/enums";
import { MessageWriter } from "@nodepolus/framework/src/util/hazelMessage";
import { LobbyCode } from "@nodepolus/framework/src/util/lobbyCode";

/**
 * Root Packet ID: `0x07` (`7`)
 */
export class CancelJoinGamePacket extends BaseRootPacket {
  constructor(
    public readonly lobbyCode: string,
  ) {
    super(RootPacketType.JoinedGame);
  }

  clone(): CancelJoinGamePacket {
    return new CancelJoinGamePacket(this.lobbyCode);
  }

  serialize(writer: MessageWriter): void {
    writer.writeInt32(LobbyCode.encode(this.lobbyCode))
      .writePackedInt32(0)
      .writePackedInt32(0)
      .writeList([], (sub, id) => sub.writePackedInt32(id));
  }
}
