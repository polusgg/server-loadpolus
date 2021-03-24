import { BaseRootPacket } from "@nodepolus/nodepolus/lib/protocol/packets/root";
import { RootPacketType } from "@nodepolus/nodepolus/lib/types/enums";
import { MessageWriter } from "@nodepolus/nodepolus/lib/util/hazelMessage";
import { LobbyCode } from "@nodepolus/nodepolus/lib/util/lobbyCode";

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
